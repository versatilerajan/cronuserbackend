require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");

const app = express();
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

  // Compound index for unique test per date + type
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
const testSchema = new mongoose.Schema({
  title: String,
  date: String,
  startTime: Date,
  endTime: Date,
  totalQuestions: Number,
  testType: { type: String, enum: ["paid", "free"], required: true }
}, { timestamps: true });

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
  submittedAt: { type: Date, default: Date.now },
  startedAt: Date,
  isLate: { type: Boolean, default: false },
  answers: [{
    questionId: String,
    selectedOption: String
  }]
}, { timestamps: true });

resultSchema.index({ testId: 1, isLate: 1, score: -1, submittedAt: 1 });

const freeResultSchema = new mongoose.Schema({
  testId: mongoose.Schema.Types.ObjectId,
  score: Number,
  totalQuestions: Number,
  submittedAt: { type: Date, default: Date.now },
}, { timestamps: true });

freeResultSchema.index({ testId: 1, score: -1, submittedAt: 1 });

const Test       = mongoose.models.Test       || mongoose.model("Test", testSchema);
const Question   = mongoose.models.Question   || mongoose.model("Question", questionSchema);
const Result     = mongoose.models.Result     || mongoose.model("Result", resultSchema);
const FreeResult = mongoose.models.FreeResult || mongoose.model("FreeResult", freeResultSchema);
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

app.get("/user/today-test", userAuth, async (req, res) => {
  try {
    await connectDB();
    const now = new Date();
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(now.getTime() + IST_OFFSET_MS);
    const todayIST = nowIST.toISOString().split("T")[0];

    const test = await Test.findOne({ date: todayIST, testType: "paid" });
    if (!test) {
      return res.status(404).json({ message: "No paid test available today" });
    }

    const startIST = new Date(test.startTime.getTime() + IST_OFFSET_MS);
    const endIST   = new Date(test.endTime.getTime()   + IST_OFFSET_MS);

    if (nowIST < startIST) {
      return res.json({
        status: "not_started",
        title: test.title,
        startTimeIST: startIST.toISOString(),
        message: "Paid test has not started yet"
      });
    }

    if (nowIST > endIST) {
      return res.json({
        status: "archived",
        title: test.title,
        endTimeIST: endIST.toISOString(),
        message: "Today's paid test has ended and is now archived.",
        testId: test._id.toString(),
        canReview: true
      });
    }

    const questions = await Question.find({ testId: test._id })
      .select("-correctOption")
      .lean();

    res.json({
      status: "active",
      testId: test._id.toString(),
      title: test.title,
      totalQuestions: test.totalQuestions,
      startTimeIST: startIST.toISOString(),
      endTimeIST: endIST.toISOString(),
      questions
    });
  } catch (err) {
    console.error("/user/today-test error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/user/submit-test/:testId", userAuth, async (req, res) => {
  try {
    await connectDB();
    const { answers } = req.body; 

    if (!Array.isArray(answers)) {
      return res.status(400).json({ message: "answers must be an array of objects" });
    }

    const test = await Test.findById(req.params.testId);
    if (!test || test.testType !== "paid") {
      return res.status(404).json({ message: "Paid test not found" });
    }

    const questions = await Question.find({ testId: test._id });
    if (questions.length === 0) {
      return res.status(404).json({ message: "No questions found for this test" });
    }

    const now = new Date();
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(now.getTime() + IST_OFFSET_MS);
    const endIST = new Date(test.endTime.getTime() + IST_OFFSET_MS);

    const isLate = nowIST > endIST;

    // Block re-attempts
    const existingResult = await Result.findOne({ userId: req.user.uid, testId: test._id });
    if (existingResult) {
      return res.status(403).json({
        message: existingResult.isLate
          ? "You have already submitted a practice (late) attempt"
          : "You have already submitted this test"
      });
    }

    let score = 0;
    const savedAnswers = answers.map(ans => {
      const q = questions.find(qq => qq._id.toString() === ans.questionId);
      if (q && ans.selectedOption === q.correctOption) score++;
      return {
        questionId: ans.questionId,
        selectedOption: ans.selectedOption || null
      };
    });

    const result = await Result.create({
      userId: req.user.uid,
      testId: test._id,
      score,
      totalQuestions: questions.length,
      submittedAt: now,
      startedAt: now, 
      isLate,
      answers: savedAnswers
    });

    if (isLate) {
      return res.json({
        message: "You are late. The test is closed. Your attempt will not be ranked.",
        score,
        totalQuestions: questions.length,
        isLate: true,
        isRanked: false
      });
    }

    // On-time attempt → calculate preliminary rank
    const betterCount = await Result.countDocuments({
      testId: test._id,
      isLate: false,
      $or: [
        { score: { $gt: score } },
        { score, submittedAt: { $lt: now } }
      ]
    });

    res.json({
      score,
      totalQuestions: questions.length,
      preliminaryRank: betterCount + 1,
      isLate: false,
      isRanked: true,
      message: "Test submitted successfully. Check your final rank at /user/my-rank/:testId"
    });
  } catch (err) {
    console.error("/user/submit-test error:", err.message);
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

    if (!result) {
      return res.status(404).json({ message: "You have not attempted this test" });
    }

    if (result.isLate) {
      return res.json({
        isLate: true,
        score: result.score,
        totalQuestions: result.totalQuestions,
        submittedAt: result.submittedAt,
        message: "This was a late attempt for practice only – no rank is available"
      });
    }

    const betterCount = await Result.countDocuments({
      testId: req.params.testId,
      isLate: false,
      $or: [
        { score: { $gt: result.score } },
        { score: result.score, submittedAt: { $lt: result.submittedAt } }
      ]
    });

    const totalRanked = await Result.countDocuments({
      testId: req.params.testId,
      isLate: false
    });

    res.json({
      score: result.score,
      totalQuestions: result.totalQuestions,
      submittedAt: result.submittedAt,
      rank: betterCount + 1,
      totalRankedParticipants: totalRanked,
      rankDisplay: `${betterCount + 1} / ${totalRanked}`,
      message: "This is your final rank among on-time participants"
    });
  } catch (err) {
    console.error("/user/my-rank error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/user/leaderboard/:testId", userAuth, async (req, res) => {
  try {
    await connectDB();
    const results = await Result.find({
      testId: req.params.testId,
      isLate: false
    })
      .sort({ score: -1, submittedAt: 1 })
      .limit(50)
      .lean();

    const total = await Result.countDocuments({
      testId: req.params.testId,
      isLate: false
    });

    res.json({
      leaderboard: results,
      totalRankedParticipants: total,
      note: "Only on-time (valid) attempts are included in the ranking"
    });
  } catch (err) {
    console.error("/user/leaderboard error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/user/review-test/:testId", userAuth, async (req, res) => {
  try {
    await connectDB();
    const test = await Test.findById(req.params.testId);
    if (!test || test.testType !== "paid") {
      return res.status(404).json({ message: "Test not found or not a paid test" });
    }

    const result = await Result.findOne({
      userId: req.user.uid,
      testId: test._id
    });

    if (!result) {
      return res.status(404).json({ message: "You did not attempt this test" });
    }

    const questions = await Question.find({ testId: test._id }).lean();

    const reviewQuestions = questions.map(q => {
      const userAnswer = result.answers.find(a => a.questionId === q._id.toString());
      return {
        questionNumber: q.questionNumber,
        questionStatement: q.questionStatement,
        options: q.options,
        yourAnswer: userAnswer?.selectedOption || null,
        correctAnswer: q.correctOption,
        isCorrect: userAnswer ? userAnswer.selectedOption === q.correctOption : false
      };
    });

    let rankInfo = null;
    if (!result.isLate) {
      const betterCount = await Result.countDocuments({
        testId: test._id,
        isLate: false,
        $or: [
          { score: { $gt: result.score } },
          { score: result.score, submittedAt: { $lt: result.submittedAt } }
        ]
      });
      const total = await Result.countDocuments({ testId: test._id, isLate: false });
      rankInfo = {
        rank: betterCount + 1,
        totalParticipants: total
      };
    }

    res.json({
      title: test.title,
      score: result.score,
      totalQuestions: result.totalQuestions,
      submittedAt: result.submittedAt,
      isLate: result.isLate,
      rankInfo,
      questions: reviewQuestions,
      message: result.isLate
        ? "This was a late attempt – shown for practice/review only (no rank)"
        : "Review your answers, correct solutions, and final rank"
    });
  } catch (err) {
    console.error("/user/review-test error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/free/today-test", async (req, res) => {
  try {
    await connectDB();

    // Find the MOST RECENT free test (persistent style)
    const test = await Test.findOne({ testType: "free" })
      .sort({ createdAt: -1 })         
      .lean();

    if (!test) {
      return res.status(404).json({ message: "No free test available at the moment" });
    }

    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(Date.now() + IST_OFFSET);
    let status = "active";

    const questions = await Question.find({ testId: test._id })
      .select("-correctOption")
      .lean();

    res.json({
      status,
      testId: test._id.toString(),
      title: test.title || "BPSC Free Practice Test",
      totalQuestions: test.totalQuestions,
      startTimeIST: test.startTime ? new Date(test.startTime.getTime() + IST_OFFSET).toISOString() : null,
      endTimeIST: test.endTime ? new Date(test.endTime.getTime() + IST_OFFSET).toISOString() : null,
      questions,
      note: "Persistent free practice test — available anytime until removed by admin",
      isPersistentFreeTest: true,
      createdAt: test.createdAt ? new Date(test.createdAt).toISOString() : null
    });
  } catch (err) {
    console.error("free/today-test error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/free/tests", async (req, res) => {
  try {
    await connectDB();

    const tests = await Test.find({ testType: "free" })
      .sort({ createdAt: -1 })          // newest first
      .select("title date totalQuestions startTime endTime createdAt")
      .lean();

    if (!tests.length) {
      return res.status(404).json({ message: "No free tests available" });
    }

    const IST_OFFSET = 5.5 * 60 * 60 * 1000;

    const formatted = tests.map(t => ({
      testId: t._id.toString(),
      title: t.title || "BPSC Free Practice Test",
      date: t.date,
      totalQuestions: t.totalQuestions,
      createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : null,
      startTimeIST: t.startTime ? new Date(t.startTime.getTime() + IST_OFFSET).toISOString() : null,
      endTimeIST: t.endTime ? new Date(t.endTime.getTime() + IST_OFFSET).toISOString() : null,
    }));

    res.json({ success: true, tests: formatted });
  } catch (err) {
    console.error("/free/tests error:", err.message);
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
      message: "Submitted – your rank is visible on the public leaderboard"
    });
  } catch (err) {
    console.error("/free/submit error:", err.message);
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
    console.error("/free/leaderboard error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = app;
