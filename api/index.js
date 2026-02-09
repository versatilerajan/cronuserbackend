require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");

const app = express();

// ================= SECURITY & MIDDLEWARE =================
app.use(express.json({ limit: "10kb" }));

// Improved CORS configuration (allows preflight and common headers)
app.use(cors({
  origin: true,                           // allow all origins for now (you can tighten later)
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  optionsSuccessStatus: 204
}));

// Explicitly handle OPTIONS preflight requests
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.sendStatus(204);
});

app.use(helmet());
app.use(compression());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500
  })
);

// ================= DATABASE (SERVERLESS SAFE) =================
let cached = global.mongoose;
if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose.connect(process.env.MONGO_URI).then((mongoose) => {
      console.log("User DB Connected");
      return mongoose;
    }).catch(err => {
      console.error("MongoDB connection failed:", err.message);
      throw err;
    });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

// ================= FIREBASE INIT WITH DEBUG LOGGING =================
if (!admin.apps.length) {
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is missing or empty");
    }

    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

    // Debug logs to verify what was loaded
    console.log("Service Account project_id:", serviceAccount.project_id || "NOT_FOUND");
    console.log("Service Account client_email:", serviceAccount.client_email || "NOT_FOUND");
    console.log("Service Account type:", serviceAccount.type || "NOT_FOUND");

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    console.log("Firebase Admin Initialized successfully");
  } catch (err) {
    console.error("Firebase init FAILED:", err.message);
    console.error("Raw env var length:", process.env.FIREBASE_SERVICE_ACCOUNT?.length || "missing");
    console.error("Raw env var (first 100 chars):", process.env.FIREBASE_SERVICE_ACCOUNT?.substring(0, 100) || "missing");
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

// ================= FIREBASE AUTH MIDDLEWARE =================
const userAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : authHeader;

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    console.error("Token verification failed:", err.code || "unknown", err.message);
    return res.status(401).json({ message: "Invalid Firebase token", error: err.message });
  }
};

// ================= ROUTES =================
app.get("/", (req, res) => {
  res.json({ status: "User Backend Running" });
});

// GET TODAY TEST
app.get("/user/today-test", userAuth, async (req, res) => {
  try {
    await connectDB();
    const today = new Date().toISOString().split("T")[0];
    const test = await Test.findOne({ date: today });

    if (!test) {
      return res.status(404).json({ message: "No test today" });
    }

    const now = new Date();
    if (now < test.startTime) {
      return res.json({ status: "not_started" });
    }

    const questions = await Question.find({ testId: test._id }).select("-correctOption");

    res.json({
      status: "active",
      testId: test._id,
      title: test.title,
      totalQuestions: test.totalQuestions,
      questions
    });
  } catch (err) {
    console.error("today-test error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// SUBMIT TEST
app.post("/user/submit-test/:testId", userAuth, async (req, res) => {
  try {
    await connectDB();
    const { answers } = req.body;

    const questions = await Question.find({ testId: req.params.testId });
    if (!questions.length) {
      return res.status(404).json({ message: "Test not found" });
    }

    let score = 0;
    questions.forEach((q) => {
      const userAnswer = answers.find(a => a.questionId === q._id.toString());
      if (userAnswer && userAnswer.selectedOption === q.correctOption) score++;
    });

    const alreadySubmitted = await Result.findOne({
      userId: req.user.uid,
      testId: req.params.testId
    });

    if (alreadySubmitted) {
      return res.status(400).json({ message: "Already submitted" });
    }

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

// ================= LOCAL DEVELOPMENT =================
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`User Backend Running on ${PORT}`));
}

module.exports = app;
