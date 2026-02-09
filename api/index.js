require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");

const app = express();

// ================= MIDDLEWARE =================
app.use(express.json({ limit: "10kb" }));

app.use(cors({
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  optionsSuccessStatus: 204
}));

app.options(/.*/, (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.sendStatus(204);
});

app.use(helmet());
app.use(compression());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500 }));

// ================= DATABASE =================
let cached = global.mongoose || { conn: null, promise: null };
global.mongoose = cached;

async function connectDB() {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI is missing in environment variables");
    }

    cached.promise = mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
    })
      .then(m => {
        console.log("MongoDB connected successfully");
        return m;
      })
      .catch(err => {
        console.error("MongoDB connection FAILED:", err.message);
        cached.promise = null;
        throw err;
      });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

// ================= FIREBASE INIT =================
let firebaseInitialized = false;

if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!raw || raw.trim() === "") {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is missing or empty");
    }

    let serviceAccount = JSON.parse(raw);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    firebaseInitialized = true;
    console.log("Firebase Admin Initialized successfully");
  } catch (err) {
    console.error("Firebase Admin Initialization FAILED:", err.message);
  }
}

// ================= SCHEMAS =================
const testSchema = new mongoose.Schema({
  title: String,
  date: String,
  startTime: Date,
  endTime: Date,
  totalQuestions: Number
}, { timestamps: true });

const questionSchema = new mongoose.Schema({
  testId: mongoose.Schema.Types.ObjectId,
  questionNumber: Number,
  questionStatement: String,
  options: {
    option1: String,
    option2: String,
    option3: String,
    option4: String
  },
  correctOption: String
});

const resultSchema = new mongoose.Schema({
  userId: String,
  testId: mongoose.Schema.Types.ObjectId,
  score: Number,
  totalQuestions: Number,
  submittedAt: { type: Date, default: Date.now }
}, { timestamps: true });

resultSchema.index({ testId: 1, score: -1 });

const Test = mongoose.models.Test || mongoose.model("Test", testSchema);
const Question = mongoose.models.Question || mongoose.model("Question", questionSchema);
const Result = mongoose.models.Result || mongoose.model("Result", resultSchema);

// ================= AUTH MIDDLEWARE =================
const userAuth = async (req, res, next) => {
  if (!firebaseInitialized) {
    return res.status(503).json({ message: "Authentication service not available" });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ message: "No token provided" });

  const token = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : authHeader;

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid Firebase token" });
  }
};

app.get("/", async (req, res) => {
  try {
    await connectDB();
    
    const today = new Date().toISOString().split("T")[0];
    const testToday = await Test.findOne({ date: today });

    res.json({
      status: "User Backend Running",
      firebaseReady: firebaseInitialized,
      mongoReady: mongoose.connection.readyState === 1 ? "connected" : "not connected",
      currentServerDateUTC: today,
      foundTestForToday: !!testToday,
      foundTestDate: testToday ? testToday.date : null,
      foundTestTitle: testToday ? testToday.title : null
    });
  } catch (err) {
    res.status(500).json({ status: "Error", error: err.message });
  }
});

// GET TODAY TEST – using IST date
app.get("/user/today-test", userAuth, async (req, res) => {
  try {
    await connectDB();

    // Calculate today in IST (UTC + 5:30)
    const nowUTC = new Date();
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes
    const nowIST = new Date(nowUTC.getTime() + IST_OFFSET_MS);
    
    // Get YYYY-MM-DD in Indian time
    const todayIST = nowIST.toISOString().split("T")[0];

    console.log("Server UTC date:", nowUTC.toISOString().split("T")[0]);
    console.log("Calculated IST date:", todayIST);

    const test = await Test.findOne({ date: todayIST });

    if (!test) {
      return res.status(404).json({ 
        message: "No test today",
        debug: { requestedDate: todayIST }
      });
    }

    // Time comparison in IST
    const startTimeIST = new Date(test.startTime.getTime() + IST_OFFSET_MS);
    const endTimeIST   = new Date(test.endTime.getTime() + IST_OFFSET_MS);

    if (nowIST < startTimeIST) {
      return res.json({
        status: "not_started",
        title: test.title,
        startTimeIST: startTimeIST.toISOString(),
        message: "Test has not started yet. Please check back later."
      });
    }

    if (nowIST > endTimeIST) {
      return res.json({
        status: "ended",
        title: test.title,
        message: "Today's test has ended."
      });
    }

    const questions = await Question.find({ testId: test._id }).select("-correctOption");

    res.json({
      status: "active",
      testId: test._id,
      title: test.title,
      totalQuestions: test.totalQuestions,
      startTimeIST: startTimeIST.toISOString(),
      endTimeIST: endTimeIST.toISOString(),
      questions
    });

  } catch (err) {
    console.error("today-test error:", err.message);
    res.status(500).json({ message: "Server error", detail: err.message });
  }
});
// SUBMIT TEST
app.post("/user/submit-test/:testId", userAuth, async (req, res) => {
  try {
    await connectDB();
    const { answers } = req.body;

    const questions = await Question.find({ testId: req.params.testId });
    if (!questions.length) return res.status(404).json({ message: "Test not found" });

    let score = 0;
    questions.forEach((q) => {
      const userAnswer = answers.find(a => a.questionId === q._id.toString());
      if (userAnswer && userAnswer.selectedOption === q.correctOption) score++;
    });

    const alreadySubmitted = await Result.findOne({
      userId: req.user.uid,
      testId: req.params.testId
    });

    if (alreadySubmitted) return res.status(400).json({ message: "Already submitted" });

    await Result.create({
      userId: req.user.uid,
      testId: req.params.testId,
      score,
      totalQuestions: questions.length
    });

    const rank = (await Result.countDocuments({
      testId: req.params.testId,
      score: { $gt: score }
    })) + 1;

    res.json({
      score,
      totalQuestions: questions.length,
      rank
    });
  } catch (err) {
    console.error("submit-test error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// LEADERBOARD
app.get("/user/leaderboard/:testId", async (req, res) => {
  try {
    await connectDB();
    const topUsers = await Result.find({ testId: req.params.testId })
      .sort({ score: -1, submittedAt: 1 })
      .limit(50);
    res.json(topUsers);
  } catch (err) {
    console.error("leaderboard error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = app;
