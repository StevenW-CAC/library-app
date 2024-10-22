/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import {onRequest, Request} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import OpenAI from 'openai';
import * as cheerio from 'cheerio';
import * as csvtojson from 'csvtojson';

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// Define the types used throughout the program
type BookLocation = {
	format: string,
	location: string,
	availability: string
}
type Book = {
	link: string,
	title: string,
	author: string,
	formats: string[],
	locations: BookLocation[]
};

// Used to prompt the assistant with a message and handle its response
async function callOpenAIAssistant(client: OpenAI, threadId: string, message: string): Promise<{
	success: boolean,
	statusCode: number,
	reason: string | undefined,
	results: any | undefined
}> {
	// Create the message in the thread
	await client.beta.threads.messages.create(
		threadId,
		{
			role: "user",
			content: message
		}
	);

	// Fetch the assistant, then create the run and execute it
	const assistant = await client.beta.assistants.retrieve("asst_79EgR0XzA5YdPgHyPaQOoGVk");
	let run = await client.beta.threads.runs.createAndPoll(
		threadId,
		{ 
			assistant_id: assistant.id
		}
	);

	// While the run is active, run the specified action necessary to continue until the run is complete
	let wasSessionCreatedSuccessfully = false;
	let activeFunction: string | undefined;
	while (true) {
		// If the run requires us to perform an action, that action being the response to function calls requested by the assistant 
		if (run.status === "requires_action" && run.required_action && run.required_action.type === "submit_tool_outputs") {
			// Loop through all actions requested and act upon them
			const toolOutputs = [];
			for (const call of run.required_action.submit_tool_outputs.tool_calls) {
				// A run is only allowed to use one type of function at a time due to the structure of the "step system"
				// in order to prevent the assistant from causing unexpected results.
				// If the function requested is different from the previous function, reject it.
				if (!activeFunction) {
					activeFunction = call.function.name;
				} else if (call.function.name !== activeFunction) {
					toolOutputs.push({
						tool_call_id: call.id,
						output: JSON.stringify({
							success: false,
							reason: "You can only call one endpoint per message. Your current active endpoint: " + activeFunction
						})
					});
					continue;
				}

				if (call.function.name === "create_session") {
					// [STEP 1] Creates a new session
					const data = JSON.parse(call.function.arguments);
					if (wasSessionCreatedSuccessfully) {
						// If the session was already created in this run, don't attempt to create a new one.
						toolOutputs.push({
							tool_call_id: call.id,
							output: JSON.stringify({
								success: false,
								reason: "The session has already been created."
							})
						});
						continue;
					} else if (data.query.split(" ").length >= 4) {
						// If the query has 5 or more words, tell the assistant to make the query more broad.
						// If it's too specific, it could return a low number of books which would not give us
						// enough data to determine the best book for the user.
						toolOutputs.push({
							tool_call_id: call.id,
							output: JSON.stringify({
								success: false,
								reason: "You have 5 or more keywords, this may be too specific of a query. Try shortening the amount of words for more accurate results."
							})
						});
						continue;
					}

					// Creates a new session by starting a search with the query determined by the assistant
					const response = await fetch(`https://catalog.washoecountylibrary.us/Union/Search?view=list&showCovers=off&lookfor=${data.query}&searchIndex=Keyword&searchSource=local`);
					
					// Error handling
					if (!response.ok) {
						toolOutputs.push({
							tool_call_id: call.id,
							output: JSON.stringify({
								success: false,
								reason: "Response from library was not an OK status."
							})
						});
						continue;
					}

					// Loads the response into an HTML parser and scrapes for a list that includes the search ID
					const $ = cheerio.load(await response.text());
					const ulElement = $('ul[aria-labelledby="dropdownSearchToolsBtn"]');
					if (ulElement.length <= 0) {
						// Could not find the list
						toolOutputs.push({
							tool_call_id: call.id,
							output: JSON.stringify({
								success: false,
								reason: "Your search query returned no results, try searching again with a different query."
							})
						});
						continue;
					}

					// Search for the first button in the list labelled "Save Search" that includes the search ID in its code
					const firstLi = ulElement.find('li').first();
					if (firstLi.length <= 0) {
						toolOutputs.push({
							tool_call_id: call.id,
							output: JSON.stringify({
								success: false,
								reason: "Failed to find the search_id from search page [layer 1]."
							})
						});
						continue;
					}

					// Read the onclick attribute on the button
					const onclick = firstLi.find('a').attr('onclick');
					if (!onclick) {
						toolOutputs.push({
							tool_call_id: call.id,
							output: JSON.stringify({
								success: false,
								reason: "Failed to find the search_id from search page [layer 2]."
							})
						});
						continue;
					}

					// Use RegEx to match in the string of where the search ID is located
					const match = onclick.match(/showSaveSearchForm\('(\d+)'\)/);
					if (match) {
						// Parse the found match into a number and report session creation as successful
						const search_id = parseInt(match[1]);
						wasSessionCreatedSuccessfully = true;
						// Return the output to the assistant
						toolOutputs.push({
							tool_call_id: call.id,
							output: JSON.stringify({
								success: true,
								search_id
							})
						});
					} else {
						// Tell the assistant that the search id could not be found
						toolOutputs.push({
							tool_call_id: call.id,
							output: JSON.stringify({
								success: false,
								reason: "Failed to read the search_id from search page."
							})
						});
					}
				} else if (call.function.name ===  "search_genres") {
					// [STEP 2] Searching genres using an existing search query ID
					const data = JSON.parse(call.function.arguments);
					const response = await fetch(`https://catalog.washoecountylibrary.us/Search/AJAX?method=searchFacetTerms&searchId=${data.search_id}&facetName=subject_facet&searchTerm=${data.query}`);
					
					// Error handling
					if (!response.ok) {
						toolOutputs.push({
							tool_call_id: call.id,
							output: JSON.stringify({
								success: false,
								reason: "Response from library was not an OK status."
							})
						});
						continue;
					}

					// Parses the response body, then reads the HTML snippet that was returned
					// and converts the subjects from the HTML list into JSON format
					const body = await response.json();
					if (body.success) {
						const $ = cheerio.load(body.facetResults);
						const subjects: string[] = [];
						// For each checkbox, parse the text and add it to the subjects list
						$(".checkboxFacet label").each((index, element) => {
							const subject = $(element).text().trim().replace(/\(\d+\)$/, '').trim();
							subjects.push(subject);
						});
						// Return the output to the assistant
						toolOutputs.push({
							tool_call_id: call.id,
							output: JSON.stringify({
								success: true,
								genres: subjects
							})
						});
					} else if ((body.message as string).includes("No results")) {
						// Tell the assistant that the search returned no results
						toolOutputs.push({
							tool_call_id: call.id,
							output: JSON.stringify({
								success: false,
								reason: "Your search query returned no results, try searching again with a different query."
							})
						});
					} else {
						// Tell the assistant that something went wrong when trying to search
						toolOutputs.push({
							tool_call_id: call.id,
							output: JSON.stringify({
								success: false,
								reason: "Undefined error when searching for genre from library."
							})
						});
					}
				} else if (call.function.name === "get_books_description") {
					// [STEP 5] Using the given list of URLs for books, retrieve the description from them for the
					// assistant to use in determining why the book they chose is the best for the user.
					const data = JSON.parse(call.function.arguments);
					const descriptions = [];
					for (const url of data.urls) {
						// Push the new description into the descriptions list that was
						// retrieved from the URL appended with the getDescription endpoint
						descriptions.push(await (await fetch(url + "/AJAX?method=getDescription")).text());
					}
					// Return the output to the assistant
					toolOutputs.push({
						tool_call_id: call.id,
						output: JSON.stringify({
							success: true,
							descriptions
						})
					});
				} else {
					// The function that is requested by the assistant was undefined and was not considered;
					// Log this as an error into Firebase and cancel execution.
					client.beta.threads.runs.cancel(threadId, run.id);
					logger.error("Function call is asking for an undefined case");
				}
			}

			// Submit outputs from the functions and continue the run
			run = await client.beta.threads.runs.submitToolOutputsAndPoll(threadId, run.id, {
				tool_outputs: toolOutputs
			})
		} else if (run.status === 'completed') {
			// Retrieve the list of messages from the thread in ascending order and fetch the latest one
			const messages = await client.beta.threads.messages.list(
				run.thread_id
			);
			// The message type SHOULD be text, if so then return it
			if (messages.data[0].content[0].type === "text") {
				return {
					success: true,
					statusCode: 200,
					reason: undefined,
					results: JSON.parse(messages.data[0].content[0].text.value)
				};
			} else {
				return {
					success: false,
					statusCode: 500,
					reason: "Response type from assistant was not text.",
					results: undefined
				}
			}
		} else {
			// Error handling if it's a status that was not considered, log it to Firebase
			logger.error("Got unexpected status from assistant: " + run.status)
			break;
		}
	}

	// If all else fails somehow, return Internal Server Error
	return {
		success: false,
		statusCode: 500,
		reason: "Internal Server Error",
		results: undefined
	}
}

// Determines whether the provided request is authenticated
function isAuthenticated(request: Request): boolean {
	return request.headers.authorization === "CAC-PUBLIC-DEMONSTRATION"
}

export const submitQuizResults = onRequest({ secrets: ["OPENAI_API_KEY"] }, async (request, response) => {
	// Determines whether the user is authenticated
	if (!isAuthenticated(request)) {
		response.sendStatus(401);
		return;
	}

	// Obtain quiz results that were passed in by the user, then map the results
	// into the format: 1. Answer
	const bodyResults = request.body.results as string[];
	const results = bodyResults.map((answer, index) => {
		return `${index + 1}. ${answer}`
	}).join("\n");
	
	// Define the OpenAI Client instance
	const client = new OpenAI({
		apiKey: process.env['OPENAI_API_KEY']
	});

	// Create a new thread and call the assistant, instructing it to proceed with Step 1.
	// Assistant will do the following:
	// -> Creates a new session that searches using keywords based on the user's answers.
	// -> Returns the library search ID as well as the OpenAI thread ID.
	const thread = await client.beta.threads.create();
	const assistantResponse = await callOpenAIAssistant(client, thread.id, `{STEP 1}\n${results}`)

	// Return the response from the assistant
	if (assistantResponse.success) {
		assistantResponse.results.thread_id = thread.id
		response.status(assistantResponse.statusCode).setHeader("Content-Type", "application/json").send(JSON.stringify(assistantResponse.results))
	} else {
		response.status(assistantResponse.statusCode).setHeader("Content-Type", "application/json").send(JSON.stringify({
			success: false,
			reason: assistantResponse.reason
		}))
	}
});

export const searchGenres = onRequest({ secrets: ["OPENAI_API_KEY"] }, async (request, response) => {
	// Determines whether the user is authenticated
	if (!isAuthenticated(request)) {
		response.sendStatus(401);
		return;
	}
	
	// Define the OpenAI Client instance
	const client = new OpenAI({
		apiKey: process.env['OPENAI_API_KEY']
	});

	// Instructs the assistant to proceed with Step 2.
	// Assistant will do the following:
	// -> Searches for genres that the user would be interested in and finds the exact terms needed for searching in a later step.
	// -> Returns these genres.
	const assistantResponse = await callOpenAIAssistant(client, request.query.threadId as string, `{STEP 2}`)

	// Return the response from the assistant
	if (assistantResponse.success) {
		response.status(assistantResponse.statusCode).setHeader("Content-Type", "application/json").send(JSON.stringify(assistantResponse.results))
	} else {
		response.status(assistantResponse.statusCode).setHeader("Content-Type", "application/json").send(JSON.stringify({
			success: false,
			reason: assistantResponse.reason
		}))
	}
});

export const determineSearchQueries = onRequest({ secrets: ["OPENAI_API_KEY"] }, async (request, response) => {
	// Determines whether the user is authenticated
	if (!isAuthenticated(request)) {
		response.sendStatus(401);
		return;
	}

	// Define the OpenAI Client instance
	const client = new OpenAI({
		apiKey: process.env['OPENAI_API_KEY']
	});

	// Instructs the assistant to proceed with Step 3.
	// Assistant will do the following:
	// -> Returns different queries and the genres to filter by that the user should execute to find books they would enjoy.
	const assistantResponse = await callOpenAIAssistant(client, request.query.threadId as string, `{STEP 3}`)

	// Return the response from the assistant
	if (assistantResponse.success) {
		response.status(assistantResponse.statusCode).setHeader("Content-Type", "application/json").send(JSON.stringify(assistantResponse.results))
	} else {
		response.status(assistantResponse.statusCode).setHeader("Content-Type", "application/json").send(JSON.stringify({
			success: false,
			reason: assistantResponse.reason
		}))
	}
});

export const retrieveBookList = onRequest(async (request, response) => {
	// Determines whether the user is authenticated
	if (!isAuthenticated(request)) {
		response.sendStatus(401);
		return;
	}

	// Obtain the queries that were found from the previous step
	const queries = request.body.queries as [{ query: string, genres: string[] }];
	let books: Book[] = [];

	// Goes through each query and fetches the search result from the library in CSV format
	for (const query of queries) {
		// Fetches the URL which adds each genre as a filter through string manipulation.
		const response = await fetch(`https://catalog.washoecountylibrary.us/Search/Results?lookfor=${query.query}&searchIndex=Keyword&sort=relevance&view=excel&searchSource=local${
			(query.genres as string[]).map((genre) => `&filter[]=subject_facet:"${genre}"`).join("")
		}`)
		// If the response returns an OK status code (2xx)
		if (response.ok) {
			// Converts the CSV response into JSON for easy manipulation
			const output = await csvtojson().fromString(await response.text()) as [
				{
					["Link"]: string,
					["Title"]: string,
					["Author"]: string,
					["Publisher"]: string,
					["Publish Date"]: string,
					["Place of Publication"]: string,
					["Format"]: string,
					["Location & Call Number"]: string
				}
			];
	
			// Uses the first 50 results from the search and maps it into a more digestable and relevant format
			const booksFromQuery = output.slice(0, 50).map((book) => {
				const entries = book["Location & Call Number"].split(',');
				const locations = entries.map(entry => {
					const parts = entry.split('::');
					const fullLocationAndCallNumber = parts[1];
					
					// Split by ' - ' to separate the location/call number from the availability
					const lastDashIndex = fullLocationAndCallNumber.lastIndexOf(' - ');
					const locationAndCallNumber = fullLocationAndCallNumber.substring(0, lastDashIndex).trim(); // Exclude the availability part
					const availability = fullLocationAndCallNumber.substring(lastDashIndex + 3).trim(); // Extract availability
	
					return {
						format: parts[0], // Format of book
						location: locationAndCallNumber, // Entire location and call number string
						availability: availability // Availability of book
					};
				});
	
				return {
					link: book.Link,
					title: book.Title,
					author: book.Author,
					formats: book.Format.split(";"),
					locations
				};
			}) as Book[];
	
			// Concatenate this list into the global list for all queries.
			books = books.concat(booksFromQuery);
		}
	}
	
	// Return the response of the list of books
	response.status(200).setHeader("Content-Type", "application/json").send(JSON.stringify({
		success: true,
		books
	}))
});

export const determineTopThreeBooks = onRequest({ secrets: ["OPENAI_API_KEY"] }, async (request, response) => {
	// Determines whether the user is authenticated
	if (!isAuthenticated(request)) {
		response.sendStatus(401);
		return;
	}

	// Obtain the books that were found from the previous step
	const books = request.body.books as Book[];
	
	// Define the OpenAI Client instance
	const client = new OpenAI({
		apiKey: process.env['OPENAI_API_KEY']
	});

	// Instructs the assistant to proceed with Step 4 (technically step 5 in the whole process, assistant did not interfere with the previous step).
	// Assistant will do the following:
	// -> Pick three books that seem would fit the user's interest the best, then fetches the description of those books
	// -> Come up with reasoning using the given description of why this book fits their qualifications based on the quiz answers
	//    from step 1.
	// -> Returns the three books' information as well as the reasoning previously described.
	const assistantResponse = await callOpenAIAssistant(client, request.query.threadId as string, `{STEP 4}\n${JSON.stringify(books)}`)

	// Return the response from the assistant
	if (assistantResponse.success) {
		response.status(assistantResponse.statusCode).setHeader("Content-Type", "application/json").send(JSON.stringify(assistantResponse.results))
	} else {
		response.status(assistantResponse.statusCode).setHeader("Content-Type", "application/json").send(JSON.stringify({
			success: false,
			reason: assistantResponse.reason
		}))
	}
});