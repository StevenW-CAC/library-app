// Button controls for simple navigation
onEvent("logInButton", "click", function( ) {
  setScreen("welcome");
});
onEvent("aboutButton", "click", function( ) {
  setScreen("about");
});
onEvent("whyUsButton", "click", function( ) {
  setScreen("whyUs");
});
onEvent("quizButton", "click", function( ) {
  setScreen("quiz");
});
onEvent("librariesButton", "click", function( ) {
  setScreen("libraries");
});
onEvent("goBackWhyUs", "click", function( ) {
  setScreen("welcome");
});
onEvent("goBackAbout", "click", function( ) {
  setScreen("welcome");
});
onEvent("goBackLibraries", "click", function( ) {
  setScreen("welcome");
});
onEvent("goBackQuiz", "click", function( ) {
  setScreen("welcome");
});
onEvent("beginQuizButton", "click", function( ) {
  quizAnswers = []; // Reset quiz answers
  setScreen("question1");
});
onEvent("logInButton", "click", function( ) {
  setScreen("welcome");
});
onEvent("goHomeButton", "click", function( ) {
  setScreen("welcome");
});

// Button controls for quiz to track answers
var quizAnswers = [];

for (var i = 0; i < 10; i++) {
  // Buttons (A to E) for each question
  for (var j = 1; j <= 5; j++) {
    let currentIndex = i;
    let letter = String.fromCharCode(64 + j);
    var buttonId = "question" + (currentIndex + 1) + letter;
    onEvent(buttonId, "click", function() {
      // Add answer to array and advance screen
      quizAnswers.push(letter);
      setScreen("question" + (currentIndex + 2));
    });
  }
}

// Submit quiz answers
var userBooks = [];
async function submitButton() {
  // Adds the open-ended question answer to the array
  quizAnswers.push(getText("text_area1"));

  // Sets screen to loading and calls function to submit answers and get recommended books
  setScreen("loading");
  const response = await submitQuizAnswers(quizAnswers);

  // If response unsuccessful, ask user if they'd like to retry
  if (!response.success) {
    const shouldReply = confirm(response.reason + "\n\nWould you like to retry?");
    if (!shouldReply) {
      setScreen("welcome");
      return;
    } else {
      submitButton();
      return;
    }
  }
  userBooks = response.books;

  // Display all information about the books on the results screen
  for (let i = 0; i < 3; i++) {
    const book = userBooks[i];
    setText("book" + (i + 1) + "-title", book.title);
    setText("book" + (i + 1) + "-author", book.author);
    setText("book" + (i + 1) + "-location", book.locations[0].location.split(" - ")[0]);
    setText("book" + (i + 1) + "-format", book.locations[0].format);
    setText("book" + (i + 1) + "-status", book.locations[0].availability);
  }

  setScreen("goHomeGreatJob");
}
onEvent("submitQ11", "click", submitButton);

// Define elements
const statusP = document.querySelector("#status");
const progressBar = document.querySelector("#progress-bar");

// Handles all functionality of submitting the quiz answers and retrieving the user's recommended books
async function submitQuizAnswers(answers) {
  if (!window.location) {
    // running on code.org; ignore call
    return {
      success: false,
      reason: "This app cannot run on code.org! Please visit https://cac-library.web.app/ to continue."
    };
  } else {
    // call API

    // Each step that the AI does in order
    const steps = [
			"submitQuizResults",
			"searchGenres",
			"determineSearchQueries",
			"retrieveBookList",
			"determineTopThreeBooks"
		];
		
    // A simple wrapper function to call the API and update the progress bar
		async function request(step, threadId, body) {
			progressBar.style.width = `${(step) / steps.length * 100}%`;
			return await fetch(`/api/step-${step}/${steps[step - 1]}?threadId=${threadId}`, {
				method: body ? "POST" : "GET",
				headers: {
					["Authorization"]: "CAC-PUBLIC-DEMONSTRATION",
					["Content-Type"]: body ? "application/json" : undefined
				},
				body: body ? JSON.stringify(body) : undefined
			});
		}

    // Handles the body of the response from the API
		async function getResponseBody(step, response) {
      // If not an "OK" response (status 2xx), return unsuccessful
			if (!response.ok) {
				console.error(`[STEP ${step}] Response was not OK`);
				console.error(response);
				return {
          success: false,
          reason: "Something went wrong! Check the developer console for more information."
        };
			}

      // If the body does not report success, return unsuccessful
			let body = await response.json();
			if (!body.success) {
				console.error(`[STEP ${step}] Response was not successful`);
				console.error(body);
				return {
          success: false,
          reason: "Something went wrong! Check the developer console for more information."
        };
			}

      // Return the body
			return {
        success: true,
        body
      };
		}

    // STEP 1
    statusP.textContent = "Determining genres from your quiz results...";

    let response = await request(1, undefined, {
      "results": answers
    });
    let bodyResponse = await getResponseBody(1, response);
    if (!bodyResponse.success) {
      return bodyResponse;
    }
    let body = bodyResponse.body;

    // Store the search ID for the library books and the thread ID (of the AI) for future API calls
    const search_id = body.search_id;
    const thread_id = body.thread_id;

    // STEP 2
    statusP.textContent = "Searching up your best genres for books...";
    response = await request(2, thread_id);
    bodyResponse = await getResponseBody(2, response);
    if (!bodyResponse.success) {
      return bodyResponse;
    }
    body = bodyResponse.body;

    // The AI will have stored this information in its thread; no need to do anything in code

    // STEP 3
    statusP.textContent = "Determining search queries for your books...";
    response = await request(3, thread_id);
    bodyResponse = await getResponseBody(3, response);
    if (!bodyResponse.success) {
      return bodyResponse;
    }
    body = bodyResponse.body;

    // Store the queries determined by the AI
    const queries = body.queries;

    // STEP 4
    statusP.textContent = "Obtaining your list of books...";
    response = await request(4, thread_id, {queries});
    bodyResponse = await getResponseBody(4, response);
    if (!bodyResponse.success) {
      return bodyResponse;
    }
    body = bodyResponse.body;

    // Store the list of all potential books that could be recommended for the user
    const books = body.books;

    // STEP 5
    statusP.textContent = "Filtering books to find the best fit for you...";
    response = await request(5, thread_id, {books});
    bodyResponse = await getResponseBody(5, response);
    if (!bodyResponse.success) {
      return bodyResponse;
    }
    body = bodyResponse.body;

    // Return the 3 recommended books determined by the AI
    const recommendedBooks = body.books;
    return {
      success: true,
      books: recommendedBooks
    };
  }
}

// Results screen: book visit buttons
onEvent("book1-visit", "click", function() {
  open(userBooks[0].link)
})
onEvent("book2-visit", "click", function() {
  open(userBooks[1].link)
})
onEvent("book3-visit", "click", function() {
  open(userBooks[2].link)
})

// Results screen: book reason buttons
onEvent("book1-reason-button", "click", function() {
  alert(userBooks[0].reason)
})
onEvent("book2-reason-button", "click", function() {
  alert(userBooks[1].reason)
})
onEvent("book3-reason-button", "click", function() {
  alert(userBooks[2].reason)
})

// Preload all screen images
var images = [];
document.querySelectorAll(".screen").forEach(function(screen) {
  var image = new Image();
  image.src = screen.style.backgroundImage.substring(5, screen.style.backgroundImage.length - 2)
})

// Function to transfer text from title screen to welcome screen
function transferText() {
  // Get the text from name input on the titleScreen
  var userInput = getText("text_area2");
  // Set the text of name on the welcome screen
  setText("text_area4", userInput);
}
// When the log-in button is clicked, transfer the text to the welcome screen
onEvent("logInButton", "click", function() {
  transferText();
  // Switch to the "welcome" screen after transferring the text
  setScreen("welcome");
});