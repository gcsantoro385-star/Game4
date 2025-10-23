// --- FIREBASE SDK IMPORTS ---
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken, setPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, collection, addDoc, onSnapshot, query, setLogLevel } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// --- GLOBAL GAME VARIABLES ---
const GAME_WIDTH = 400; // Matches max-w-400px
const GAME_HEIGHT = window.innerHeight;
const CAR_WIDTH = 40;
const CAR_HEIGHT = 70;
const LANE_WIDTH = GAME_WIDTH / 3;
const PLAYER_LANES = [LANE_WIDTH / 2 - CAR_WIDTH / 2, LANE_WIDTH + LANE_WIDTH / 2 - CAR_WIDTH / 2, LANE_WIDTH * 2 + LANE_WIDTH / 2 - CAR_WIDTH / 2];

let game;
let playerCar;
let traffic = [];
let score = 0;
let gameSpeed = 5; // Base speed
let roadOffset = 0;
let lineMarkers = [];
let lastEnemyTime = 0;
let currentLane = 1; // 0, 1, 2
let maxHighScore = 0;

// NEW BOOST VARIABLES
let isBoosting = false;
const MAX_BOOST_DURATION = 180; // Frames (approx 3 seconds)
let boostCharge = MAX_BOOST_DURATION; // Starts fully charged
const BOOST_DRAIN_RATE = 1;
const BOOST_RECHARGE_RATE = 0.5;

// --- FIREBASE SETUP ---
// NOTE: Vercel environment variables are typically injected here for the config.
// The original code used global variables (__firebase_config, etc.) which is
// common in specific deployment environments. For standard Vercel static deployment,
// you might need to hardcode the config if you don't use serverless functions
// or an environment that injects these globally.
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const PUBLIC_COLLECTION = `artifacts/${appId}/public/data/highway_highscores`;

let db;
let auth;
let userId;

const scoreDisplay = document.getElementById('scoreDisplay');
const gameContainer = document.getElementById('gameContainer');
const gameOverlay = document.getElementById('gameOverlay');
const startButton = document.getElementById('startButton');
const overlayTitle = document.getElementById('overlayTitle');
const overlayMessage = document.getElementById('overlayMessage');
const finalScoreSpan = document.getElementById('finalScore');
const highScoreSpan = document.getElementById('highScore');
const gameOverStats = document.getElementById('gameOverStats');
const leaderboardList = document.getElementById('leaderboardList');
const authStatus = document.getElementById('authStatus');

// NEW BOOST ELEMENTS
const boostButton = document.getElementById('boostButton');
const boostBar = document.getElementById('boostBar');

// Function to convert base64 to ArrayBuffer (required for Firestore setup)
const base64ToArrayBuffer = (base64) => {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
};

// --- GAME OBJECTS AND CLASSES ---

class Car {
    constructor(x, y, color, isPlayer = false) {
        this.x = x;
        this.y = y;
        this.width = CAR_WIDTH;
        this.height = CAR_HEIGHT;
        this.color = color;
        this.isPlayer = isPlayer;

        this.element = document.createElement('div');
        // CUSTOM LOOK: Player car now uses a distinct Emerald color
        this.element.className = 'car ' + (isPlayer ? 'player-car bg-emerald-500' : `enemy-car ${color}`);
        this.element.style.left = `${this.x}px`;
        this.element.style.top = `${this.y}px`;
        
        // Add a small internal detail for a modern look
        this.element.innerHTML = '<div class="absolute inset-x-2 top-2 h-2 bg-white/20 rounded-full"></div>';

        gameContainer.appendChild(this.element);
    }

    update(speed) {
        if (!this.isPlayer) {
            this.y += speed;
            this.element.style.top = `${this.y}px`;
        }
    }

    checkCollision(otherCar) {
        return (
            this.x < otherCar.x + otherCar.width &&
            this.x + this.width > otherCar.x &&
            this.y < otherCar.y + otherCar.height &&
            this.y + this.height > otherCar.y
        );
    }

    remove() {
        this.element.remove();
    }
}

// --- GAME LOGIC FUNCTIONS ---

function initGame() {
    // Reset state
    game = { running: false, loop: null, frameCount: 0 };
    score = 0;
    traffic.forEach(car => car.remove());
    traffic = [];
    gameSpeed = 5;
    roadOffset = 0;
    currentLane = 1; // Start in the middle lane
    
    // NEW: Reset Boost state
    isBoosting = false;
    boostCharge = MAX_BOOST_DURATION;
    playerCar?.element.classList.remove('boost-glow');
    updateBoostDisplay();


    // Clear all previous cars and lines
    document.querySelectorAll('.player-car, .enemy-car, .road-line').forEach(el => el.remove());
    lineMarkers = [];

    // Initialize player car
    const initialX = PLAYER_LANES[currentLane];
    const initialY = GAME_HEIGHT - CAR_HEIGHT - 50;
    playerCar = new Car(initialX, initialY, 'bg-emerald-500', true);

    scoreDisplay.textContent = score;

    // Generate initial road lines
    for (let i = 0; i < 20; i++) {
        createRoadLine(i * 100);
    }

    // Hide overlay, show game area
    gameOverlay.classList.add('hidden');
    gameOverStats.classList.add('hidden');
}

function createRoadLine(y) {
    const line = document.createElement('div');
    line.className = 'road-line';
    line.style.height = '50px';
    line.style.top = `${y - 100}px`;
    
    const leftLine = line.cloneNode();
    leftLine.classList.add('road-line-left');
    gameContainer.appendChild(leftLine);
    lineMarkers.push({ el: leftLine, y: y });

    const rightLine = line.cloneNode();
    rightLine.classList.add('road-line-right');
    gameContainer.appendChild(rightLine);
    lineMarkers.push({ el: rightLine, y: y });
}

function spawnEnemy() {
    const lane = Math.floor(Math.random() * 3);
    const x = PLAYER_LANES[lane];
    const color = ['bg-red-500', 'bg-yellow-500', 'bg-purple-500'][Math.floor(Math.random() * 3)];
    
    // Spawn just above the visible screen
    const enemy = new Car(x, -CAR_HEIGHT - 10, color, false);
    traffic.push(enemy);

    // Adjust spawn rate based on speed (min 800ms between cars)
    lastEnemyTime = game.frameCount;
}

function gameLoop(timestamp) {
    if (!game.running) return;

    game.frameCount++;

    // NEW: Calculate current effective speed
    const currentSpeed = isBoosting ? gameSpeed * 2 : gameSpeed;
    
    // 1. Update Boost State
    if (isBoosting) {
        boostCharge -= BOOST_DRAIN_RATE;
        playerCar.element.classList.add('boost-glow');
        if (boostCharge <= 0) {
            isBoosting = false;
            boostCharge = 0;
            playerCar.element.classList.remove('boost-glow');
        }
    } else {
        // Recharge boost slowly when not boosting
        boostCharge = Math.min(MAX_BOOST_DURATION, boostCharge + BOOST_RECHARGE_RATE);
        playerCar?.element.classList.remove('boost-glow');
    }
    updateBoostDisplay();


    // 2. Update Score and Speed
    if (game.frameCount % 10 === 0) { // Update score every 10 frames
        score += Math.floor(currentSpeed / 2); // Score scales with current speed
        scoreDisplay.textContent = score;

        // Gradually increase base speed (unaffected by boost)
        gameSpeed = Math.min(15, 5 + score / 500);
    }

    // 3. Road Scrolling
    roadOffset += currentSpeed;
    if (roadOffset >= 100) {
        roadOffset = 0;
    }

    lineMarkers.forEach(line => {
        line.y += currentSpeed;
        if (line.y > GAME_HEIGHT + 100) {
            line.y = -100; // Reset above screen
        }
        line.el.style.top = `${line.y}px`;
    });

    // 4. Enemy Car Movement and Spawning
    const spawnInterval = Math.max(20, 100 - gameSpeed * 5); // Faster speed = shorter interval
    if (game.frameCount - lastEnemyTime > spawnInterval) {
        spawnEnemy();
    }

    traffic.forEach(car => car.update(currentSpeed)); // Traffic moves at current speed

    // Remove off-screen cars
    traffic = traffic.filter(car => {
        if (car.y > GAME_HEIGHT) {
            car.remove();
            return false;
        }
        return true;
    });

    // 5. Collision Detection
    for (let enemy of traffic) {
        if (playerCar.checkCollision(enemy)) {
            endGame();
            return;
        }
    }

    // 6. Update Player Car Position (smooth transition in CSS)
    playerCar.x = PLAYER_LANES[currentLane];
    playerCar.element.style.left = `${playerCar.x}px`;

    game.loop = requestAnimationFrame(gameLoop);
}

function handleBoost() {
    // Only allow boost if charged and game is running
    if (game.running && boostCharge >= MAX_BOOST_DURATION) {
        isBoosting = true;
    }
}

function updateBoostDisplay() {
    const percentage = (boostCharge / MAX_BOOST_DURATION) * 100;
    boostBar.style.width = `${percentage}%`;
    
    // Enable button only if fully charged and not currently boosting
    boostButton.disabled = isBoosting || boostCharge < MAX_BOOST_DURATION;
    
    if (isBoosting) {
        boostButton.textContent = "BOOSTING";
        boostButton.classList.remove('bg-cyan-600');
        boostButton.classList.add('bg-green-500');
    } else {
        boostButton.textContent = "BOOST";
        boostButton.classList.remove('bg-green-500');
        boostButton.classList.add('bg-cyan-600');
    }
}


function startGame() {
    if (game && game.running) return;
    initGame();
    game.running = true;
    game.loop = requestAnimationFrame(gameLoop);
    // Re-attach listeners just in case
    document.addEventListener('keydown', handleKeyDown);
    document.getElementById('leftButton').addEventListener('touchstart', (e) => { e.preventDefault(); changeLane(-1); }, { passive: false });
    document.getElementById('rightButton').addEventListener('touchstart', (e) => { e.preventDefault(); changeLane(1); }, { passive: false });
}

function endGame() {
    game.running = false;
    cancelAnimationFrame(game.loop);
    document.removeEventListener('keydown', handleKeyDown);

    // Check and update high score
    if (score > maxHighScore) {
        maxHighScore = score;
    }

    // Display Game Over screen
    overlayTitle.textContent = "GAME OVER!";
    overlayMessage.textContent = "You crashed! Better luck next time.";
    startButton.textContent = "RESTART";
    finalScoreSpan.textContent = score;
    highScoreSpan.textContent = maxHighScore;
    gameOverStats.classList.remove('hidden');
    gameOverlay.classList.remove('hidden');

    // Save score to Firestore
    saveScore(score);
}

function changeLane(direction) {
    currentLane = Math.max(0, Math.min(2, currentLane + direction));
}

// --- INPUT HANDLERS ---
function handleKeyDown(event) {
    if (!game.running) return;
    if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'a') {
        changeLane(-1);
    } else if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'd') {
        changeLane(1);
    } else if (event.key.toLowerCase() === 'shift' || event.key.toLowerCase() === ' ' || event.key.toLowerCase() === 'w') {
        // Use Shift, Space, or W key to activate boost
        handleBoost();
    }
}

// Mobile button handlers
document.getElementById('leftButton').addEventListener('click', () => changeLane(-1));
document.getElementById('rightButton').addEventListener('click', () => changeLane(1));

// NEW: Boost button handler
boostButton.addEventListener('click', handleBoost);


// Start button handler
startButton.addEventListener('click', () => {
    if (!game || !game.running) {
        startGame();
    }
});


// --- FIREBASE AND LEADERBOARD FUNCTIONS ---

async function saveScore(s) {
    if (!db) {
        console.error("Firestore not initialized.");
        return;
    }
    if (s === 0) return; // Don't save zero scores

    const docData = {
        userId: userId,
        score: s,
        timestamp: Date.now()
    };
    try {
        await addDoc(collection(db, PUBLIC_COLLECTION), docData);
        console.log("Score saved successfully!");
    } catch (e) {
        console.error("Error saving score:", e);
    }
}

function updateLeaderboard(scores) {
    leaderboardList.innerHTML = '';
    let listContent = '';
    
    // Update max high score for local comparison
    if (scores.length > 0) {
        maxHighScore = scores[0].score;
    } else {
        maxHighScore = 0;
    }
    
    // Only show top 5
    scores.slice(0, 5).forEach((item, index) => {
        const isCurrentUser = item.userId === userId;
        const userTag = isCurrentUser ? '(You)' : item.userId; // Show full ID as required
        
        listContent += `
            <div class="flex justify-between items-center p-2 rounded ${isCurrentUser ? 'bg-blue-600 font-bold' : 'bg-slate-700'}">
                <span class="text-lg">${index + 1}.</span>
                <span class="flex-1 ml-4 text-xs break-all">${userTag}</span>
                <span class="text-yellow-300 font-extrabold">${item.score}</span>
            </div>
        `;
    });
    
    if (scores.length === 0) {
        listContent = '<p class="text-gray-500 text-center">No scores posted yet.</p>';
    }

    leaderboardList.innerHTML = listContent;
}

async function setupFirebase() {
    try {
        // IMPORTANT: Set log level to Debug to help with any Firestore issues
        setLogLevel('Debug');
        
        const app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);
        
        // Set persistence to session to maintain state across reloads in the current session
        await setPersistence(auth, browserSessionPersistence);

        // Authenticate user
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
            await signInWithCustomToken(auth, __initial_auth_token);
        } else {
            await signInAnonymously(auth);
        }
        
        userId = auth.currentUser?.uid || `anon-${crypto.randomUUID()}`;
        // CUSTOMIZATION: Show full userId as required
        authStatus.textContent = `User ID: ${userId}`; 
        
        console.log("Firebase initialized. User ID:", userId);

        // Start real-time listener for high scores
        onSnapshot(query(collection(db, PUBLIC_COLLECTION)), (snapshot) => {
            const scores = [];
            snapshot.forEach(doc => scores.push(doc.data()));
            // Client-side sorting is mandatory to avoid complex index requirements
            scores.sort((a, b) => b.score - a.score);
            updateLeaderboard(scores);
        });

    } catch (e) {
        console.error("Error setting up Firebase:", e);
        authStatus.textContent = "Auth Error: Cannot connect to services.";
    }
}

// --- INITIALIZATION ---
window.onload = () => {
    // Set the game container height to match the window height dynamically
    gameContainer.style.height = `${window.innerHeight}px`;
    
    // Initialize Firebase and start listening for scores
    setupFirebase();
    
    // Show initial screen
    gameOverlay.classList.remove('hidden');
};

// Handle window resize for responsiveness
window.addEventListener('resize', () => {
    gameContainer.style.height = `${window.innerHeight}px`;
});