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
    if (!process.env.MONGO_URI) throw new Error("MONGO_URI is missing");
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

  // Create compound unique index (run once - safe to call multiple times)
  await mongoose.model("Test").collection.createIndex(
    { date: 1, testType: 1 },
    { unique: true, background: true }
  );

  return cached.conn;
}

// ================= FIREBASE INIT =================
let firebaseInitialized = false;
if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw || raw.trim() === "") throw new Error("FIREBASE_SERVICE_ACCOUNT missing");
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
  totalQuestions: Number,
  testType: { type: String, enum: ["paid", "free"], required: true }
}, { timestamps: true });

// Compound unique index → one paid + one free per date is allowed
testSchema.index({ date: 1, testType: 1 }, { unique: true });

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
  submittedAt: { type: Date, default: Date.now, required: true },
}, { timestamps: true });

resultSchema.index({ testId: 1, score: -1, submittedAt: 1 });

const freeResultSchema = new mongoose.Schema({
  testId: mongoose.Schema.Types.ObjectId,
  score: Number,
  totalQuestions: Number,
  submittedAt: { type: Date, default: Date.now, required: true },
}, { timestamps: true });

freeResultSchema.index({ testId: 1, score: -1, submittedAt: 1 });

const Test = mongoose.models.Test || mongoose.model("Test", testSchema);
const Question = mongoose.models.Question || mongoose.model("Question", questionSchema);
const Result = mongoose.models.Result || mongoose.model("Result", resultSchema);
const FreeResult = mongoose.models.FreeResult || mongoose.model("FreeResult", freeResultSchema);

// ================= AUTH MIDDLEWARE =================
const userAuth = async (req, res, next) => {
  if (!firebaseInitialized) return res.status(503).json({ message: "Auth service unavailable" });
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

// ================= ROUTES =================
app.get("/", async (req, res) => {
  try {
    await connectDB();
    const today = new Date().toISOString().split("T")[0];
    res.json({
      status: "User Backend Running",
      firebaseReady: firebaseInitialized,
      mongoReady: mongoose.connection.readyState === 1 ? "connected" : "not connected",
      currentServerDateUTC: today,
    });
  } catch (err) {
    res.status(500).json({ status: "Error", error: err.message });
  }
});

// ────────────────────────────────────────────────
//           PAID / AUTHENTICATED TEST ROUTES
// ────────────────────────────────────────────────

app.get("/user/today-test", userAuth, async (req, res) => {
  try {
    await connectDB();
    const nowUTC = new Date();
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(nowUTC.getTime() + IST_OFFSET_MS);
    const todayIST = nowIST.toISOString().split("T")[0];

    // Only paid tests for authenticated users
    const test = await Test.findOne({ date: todayIST, testType: "paid" });
    if (!test) {
      return res.status(404).json({ message: "No paid test available today" });
    }

    const startTimeIST = new Date(test.startTime.getTime() + IST_OFFSET_MS);
    const endTimeIST   = new Date(test.endTime.getTime()   + IST_OFFSET_MS);

    if (nowIST < startTimeIST) {
      return res.json({
        status: "not_started",
        title: test.title,
        startTimeIST: startTimeIST.toISOString(),
        message: "Paid test starts at 00:00 IST"
      });
    }

    if (nowIST > endTimeIST) {
      return res.json({
        status: "ended",
        title: test.title,
        message: "Today's paid test has ended."
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
    console.error("paid/today-test error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/user/submit-test/:testId", userAuth, async (req, res) => {
  try {
    await connectDB();
    const { answers } = req.body;

    const questions = await Question.find({ testId: req.params.testId });
    if (!questions.length) return res.status(404).json({ message: "Test not found" });

    let score = 0;
    questions.forEach(q => {
      const ua = answers.find(a => a.questionId === q._id.toString());
      if (ua && ua.selectedOption === q.correctOption) score++;
    });

    const already = await Result.findOne({ userId: req.user.uid, testId: req.params.testId });
    if (already) return res.status(400).json({ message: "Already submitted" });

    const result = await Result.create({
      userId: req.user.uid,
      testId: req.params.testId,
      score,
      totalQuestions: questions.length
    });

    const betterCount = await Result.countDocuments({
      testId: req.params.testId,
      $or: [
        { score: { $gt: score } },
        { score, submittedAt: { $lt: result.submittedAt } }
      ]
    });

    res.json({
      score,
      totalQuestions: questions.length,
      preliminaryRank: betterCount + 1,
      message: "Use /user/my-rank for final position"
    });
  } catch (err) {
    console.error("paid/submit-test error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/user/my-rank/:testId", userAuth, async (req, res) => {
  try {
    await connectDB();

    const result = await Result.findOne({
      userId: req.user.uid,
      testId: req.params.testId
    });

    if (!result) return res.status(404).json({ message: "You have not submitted this test" });

    const betterCount = await Result.countDocuments({
      testId: req.params.testId,
      $or: [
        { score: { $gt: result.score } },
        { score: result.score, submittedAt: { $lt: result.submittedAt } }
      ]
    });

    const ties = await Result.countDocuments({
      testId: req.params.testId,
      score: result.score,
      submittedAt: result.submittedAt
    });

    const rank = betterCount + 1;
    const total = await Result.countDocuments({ testId: req.params.testId });

    res.json({
      yourScore: result.score,
      submittedAt: result.submittedAt,
      rank,
      rankDisplay: `${rank} / ${total}`,
      tiesInGroup: ties,
      message: ties > 1 ? `Tied with ${ties - 1} others` : "Unique position"
    });
  } catch (err) {
    console.error("paid/my-rank error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/user/leaderboard/:testId", userAuth, async (req, res) => {
  try {
    await connectDB();
    const results = await Result.find({ testId: req.params.testId })
      .sort({ score: -1, submittedAt: 1 })
      .limit(50)
      .lean();

    const total = await Result.countDocuments({ testId: req.params.testId });

    res.json({ leaderboard: results, totalParticipants: total });
  } catch (err) {
    console.error("paid/leaderboard error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// ────────────────────────────────────────────────
//           FREE TEST SERIES – PUBLIC + RANKING
// ────────────────────────────────────────────────

// ────────────────────────────────────────────────
//           FREE TEST SERIES – PERSISTENT / EVERGREEN
// ────────────────────────────────────────────────

app.get("/free/today-test", async (req, res) => {
  try {
    await connectDB();

    const now = new Date();
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(now.getTime() + IST_OFFSET);

    // Find the MOST RECENT free test (no date filter)
    // You can later add isActive: true if you want to control visibility
    const test = await Test.findOne({ testType: "free" })
      .sort({ createdAt: -1 })           // newest first
      .lean();

    if (!test) {
      return res.status(404).json({ message: "No free test available at the moment" });
    }

    const startIST = test.startTime ? new Date(test.startTime.getTime() + IST_OFFSET) : null;
    const endIST   = test.endTime   ? new Date(test.endTime.getTime()   + IST_OFFSET)   : null;

    // Optional: if you still want time window check for free tests, keep this
    // If you want completely unlimited access → remove the time checks below
    let status = "active";
    if (startIST && nowIST < startIST) {
      status = "not_started";
    } else if (endIST && nowIST > endIST) {
      status = "ended";
    }

    const questions = await Question.find({ testId: test._id })
      .select("-correctOption")
      .lean();

    res.json({
      status,
      testId: test._id.toString(),
      title: test.title,
      totalQuestions: test.totalQuestions,
      startTimeIST: startIST?.toISOString() || null,
      endTimeIST: endIST?.toISOString() || null,
      questions,
      note: "This is a persistent free practice test — available anytime until deleted by admin",
      isPersistentFreeTest: true 
    });
  } catch (err) {
    console.error("free/today-test error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/free/submit-test/:testId", async (req, res) => {
  try {
    await connectDB();
    const { answers } = req.body;

    if (!Array.isArray(answers)) return res.status(400).json({ message: "answers must be array" });

    const questions = await Question.find({ testId: req.params.testId });
    if (!questions.length) return res.status(404).json({ message: "Test not found" });

    let score = 0;
    questions.forEach(q => {
      const ua = answers.find(a => a.questionId === q._id.toString());
      if (ua && ua.selectedOption === q.correctOption) score++;
    });

    const result = await FreeResult.create({
      testId: req.params.testId,
      score,
      totalQuestions: questions.length
    });

    const betterCount = await FreeResult.countDocuments({
      testId: req.params.testId,
      $or: [
        { score: { $gt: score } },
        { score, submittedAt: { $lt: result.submittedAt } }
      ]
    });

    const total = await FreeResult.countDocuments({ testId: req.params.testId });

    res.json({
      score,
      total,
      yourRank: betterCount + 1,
      rankDisplay: `${betterCount + 1} / ${total}`,
      message: "Submitted – your rank is now visible on the public leaderboard"
    });
  } catch (err) {
    console.error("free/submit error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/free/leaderboard/:testId", async (req, res) => {
  try {
    await connectDB();

    const results = await FreeResult.find({ testId: req.params.testId })
      .sort({ score: -1, submittedAt: 1 })
      .limit(100)
      .lean();

    const total = await FreeResult.countDocuments({ testId: req.params.testId });

    const leaderboard = results.map((r, idx) => ({
      rank: idx + 1,
      score: r.score,
      totalQuestions: r.totalQuestions,
      submittedAt: r.submittedAt
    }));

    res.json({
      leaderboard,
      totalParticipants: total
    });
  } catch (err) {
    console.error("free/leaderboard error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = app;
