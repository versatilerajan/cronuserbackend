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

  // Indexes for performance
  await mongoose.model("Test").collection.createIndex(
    { date: 1, testType: 1 },
    { unique: true, background: true }
  );
  await mongoose.model("Result").collection.createIndex(
    { testId: 1, phase: 1, isLate: 1, score: -1, submittedAt: 1 },
    { background: true }
  );

  return cached.conn;
}

// Firebase Admin Initialization
let firebaseInitialized = false;
if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw || raw.trim() === "") throw new Error("FIREBASE_SERVICE_ACCOUNT missing");
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    firebaseInitialized = true;
    console.log("Firebase Admin Initialized successfully");
  } catch (err) {
    console.error("Firebase Admin Initialization FAILED:", err.message);
  }
}

// ─── SCHEMAS ──────────────────────────────────────────────────────
const testSchema = new mongoose.Schema({
  title: String,
  date: String,
  startTime: Date,
  endTime: Date,
  totalQuestions: Number,
  testType: { type: String, enum: ["paid", "free"], required: true },
  isSundayFullTest: { type: Boolean, default: false },
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
  correctOption: String,
  phase: { type: String, enum: ["GS", "CSAT"], default: "GS" }
});

const resultSchema = new mongoose.Schema({
  userId: String,
  testId: mongoose.Schema.Types.ObjectId,
  phase: { type: String, enum: ["GS", "CSAT"], required: true },
  score: Number,              // net score after negative marking
  correct: Number,
  incorrect: Number,
  unattempted: Number,
  attempted: Number,
  totalQuestions: Number,
  submittedAt: { type: Date, default: Date.now },
  startedAt: Date,
  isLate: { type: Boolean, default: false },
  answers: [{
    questionId: String,
    selectedOption: String
  }]
}, { timestamps: true });

const freeResultSchema = new mongoose.Schema({
  testId: mongoose.Schema.Types.ObjectId,
  score: Number,
  totalQuestions: Number,
  submittedAt: { type: Date, default: Date.now },
}, { timestamps: true });

const Test = mongoose.models.Test || mongoose.model("Test", testSchema);
const Question = mongoose.models.Question || mongoose.model("Question", questionSchema);
const Result = mongoose.models.Result || mongoose.model("Result", resultSchema);
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

// ─── HELPERS ──────────────────────────────────────────────────────
function calculateNetScore(correct, incorrect) {
  const marksPerCorrect = 2;
  const negativePerWrong = 2 / 3;   // 1/3 of 2 marks
  return (correct * marksPerCorrect) - (incorrect * negativePerWrong);
}

// ─── ROUTES ───────────────────────────────────────────────────────
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
    const endIST   = new Date(test.endTime.getTime() + IST_OFFSET_MS);

    if (nowIST < startIST) {
      return res.json({
        status: "not_started",
        title: test.title,
        startTimeIST: startIST.toISOString(),
        message: "Test has not started yet"
      });
    }

    if (nowIST > endIST) {
      return res.json({
        status: "archived",
        title: test.title,
        endTimeIST: endIST.toISOString(),
        message: "Today's test has ended and is now archived.",
        testId: test._id.toString(),
        canReview: true
      });
    }

    const questions = await Question.find({ testId: test._id })
      .select("-correctOption")
      .sort({ questionNumber: 1 })
      .lean();

    const response = {
      status: "active",
      testId: test._id.toString(),
      title: test.title,
      totalQuestions: test.totalQuestions,
      startTimeIST: startIST.toISOString(),
      endTimeIST: endIST.toISOString(),
      isSundayFullTest: !!test.isSundayFullTest,
    };

    if (test.isSundayFullTest) {
      const gs   = questions.filter(q => q.phase === "GS");
      const csat = questions.filter(q => q.phase === "CSAT");
      response.phases = {
        GS:   { count: gs.length,   questions: gs   },
        CSAT: { count: csat.length, questions: csat },
      };
    } else {
      response.questions = questions;
    }

    res.json(response);
  } catch (err) {
    console.error("/user/today-test error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/user/submit-test/:testId", userAuth, async (req, res) => {
  try {
    await connectDB();

    const { phase, answers } = req.body;
    if (!["GS", "CSAT"].includes(phase)) {
      return res.status(400).json({ message: "phase must be 'GS' or 'CSAT'" });
    }
    if (!Array.isArray(answers)) {
      return res.status(400).json({ message: "answers must be an array of objects" });
    }

    const test = await Test.findById(req.params.testId);
    if (!test || test.testType !== "paid") {
      return res.status(404).json({ message: "Paid test not found" });
    }

    const now = new Date();
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(now.getTime() + IST_OFFSET_MS);
    const endIST = new Date(test.endTime.getTime() + IST_OFFSET_MS);
    const isLate = nowIST > endIST;

    // Prevent multiple on-time submissions for same phase
    const existing = await Result.findOne({
      userId: req.user.uid,
      testId: test._id,
      phase,
      isLate: false
    });
    if (existing) {
      return res.status(403).json({
        message: `You have already submitted ${phase} phase on time`
      });
    }

    let qFilter = { testId: test._id };
    if (test.isSundayFullTest) {
      qFilter.phase = phase;
    }

    const questions = await Question.find(qFilter).lean();
    if (questions.length === 0) {
      return res.status(404).json({ message: "No questions found for this phase" });
    }

    let correct = 0;
    let incorrect = 0;
    let unattempted = 0;
    let attempted = 0;

    const savedAnswers = answers.map(ans => {
      const q = questions.find(qq => qq._id.toString() === ans.questionId);
      if (!q) return { questionId: ans.questionId, selectedOption: null };

      const selected = ans.selectedOption;
      if (!selected) {
        unattempted++;
        return { questionId: ans.questionId, selectedOption: null };
      }

      attempted++;
      if (selected === q.correctOption) {
        correct++;
      } else {
        incorrect++;
      }

      return { questionId: ans.questionId, selectedOption: selected };
    });

    const score = calculateNetScore(correct, incorrect);

    const result = await Result.create({
      userId: req.user.uid,
      testId: test._id,
      phase,
      score,
      correct,
      incorrect,
      unattempted,
      attempted,
      totalQuestions: questions.length,
      submittedAt: now,
      startedAt: now,
      isLate,
      answers: savedAnswers
    });

    const responseBase = {
      phase,
      score: Math.round(score * 100) / 100,
      correct,
      incorrect,
      unattempted,
      totalQuestions: questions.length,
      isLate,
      ranked: !isLate
    };

    if (isLate) {
      return res.json({
        ...responseBase,
        message: "Test window closed. Attempt saved for practice only (no ranking)."
      });
    }

    // Calculate phase rank
    const betterCount = await Result.countDocuments({
      testId: test._id,
      phase,
      isLate: false,
      $or: [
        { score: { $gt: score } },
        { score: score, submittedAt: { $lt: now } }
      ]
    });

    const totalRanked = await Result.countDocuments({
      testId: test._id,
      phase,
      isLate: false
    });

    responseBase.rank = betterCount + 1;
    responseBase.totalRankedParticipants = totalRanked;

    // If Sunday test and both phases done → add combined rank
    if (test.isSundayFullTest) {
      const gsResult   = await Result.findOne({ userId: req.user.uid, testId: test._id, phase: "GS",   isLate: false });
      const csatResult = await Result.findOne({ userId: req.user.uid, testId: test._id, phase: "CSAT", isLate: false });

      if (gsResult && csatResult) {
        const combinedScore = gsResult.score + csatResult.score;

        const betterCombined = await Result.aggregate([
          { $match: { testId: test._id, isLate: false, phase: { $in: ["GS", "CSAT"] } } },
          { $group: { _id: "$userId", totalScore: { $sum: "$score" } } },
          { $match: { totalScore: { $gt: combinedScore } } },
          { $count: "count" }
        ]);

        const combinedRank = (betterCombined[0]?.count || 0) + 1;
        const totalUnique = await Result.distinct("userId", {
          testId: test._id,
          isLate: false,
          phase: { $in: ["GS", "CSAT"] }
        }).then(arr => new Set(arr).size);

        responseBase.combined = {
          score: Math.round(combinedScore * 100) / 100,
          rank: combinedRank,
          totalParticipants: totalUnique
        };
      }
    }

    res.json(responseBase);
  } catch (err) {
    console.error("/user/submit-test error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/user/my-rank/:testId", userAuth, async (req, res) => {
  try {
    await connectDB();

    const test = await Test.findById(req.params.testId);
    if (!test) return res.status(404).json({ message: "Test not found" });

    const phases = test.isSundayFullTest ? ["GS", "CSAT"] : ["GS"];

    const userResults = await Result.find({
      userId: req.user.uid,
      testId: test._id,
      phase: { $in: phases },
      isLate: false
    }).lean();

    if (userResults.length === 0) {
      return res.status(404).json({ message: "No on-time ranked attempt found" });
    }

    const response = { phases: {} };

    for (const r of userResults) {
      const better = await Result.countDocuments({
        testId: test._id,
        phase: r.phase,
        isLate: false,
        $or: [
          { score: { $gt: r.score } },
          { score: r.score, submittedAt: { $lt: r.submittedAt } }
        ]
      });

      const total = await Result.countDocuments({
        testId: test._id,
        phase: r.phase,
        isLate: false
      });

      response.phases[r.phase] = {
        score: Math.round(r.score * 100) / 100,
        correct: r.correct,
        incorrect: r.incorrect,
        unattempted: r.unattempted,
        rank: better + 1,
        totalParticipants: total
      };
    }

    // Combined rank for Sunday
    if (test.isSundayFullTest && userResults.length === 2) {
      const combinedScore = userResults.reduce((sum, r) => sum + r.score, 0);

      const betterCombined = await Result.aggregate([
        { $match: { testId: test._id, isLate: false, phase: { $in: ["GS", "CSAT"] } } },
        { $group: { _id: "$userId", total: { $sum: "$score" } } },
        { $match: { total: { $gt: combinedScore } } },
        { $count: "count" }
      ]);

      const combinedRank = (betterCombined[0]?.count || 0) + 1;
      const totalUsers = await Result.distinct("userId", {
        testId: test._id,
        isLate: false,
        phase: { $in: ["GS", "CSAT"] }
      }).then(ids => new Set(ids).size);

      response.combined = {
        score: Math.round(combinedScore * 100) / 100,
        rank: combinedRank,
        totalParticipants: totalUsers
      };
    }

    res.json(response);
  } catch (err) {
    console.error("/user/my-rank error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/user/leaderboard/:testId", userAuth, async (req, res) => {
  try {
    await connectDB();
    const test = await Test.findById(req.params.testId);
    if (!test) return res.status(404).json({ message: "Test not found" });

    if (!test.isSundayFullTest) {
      // Normal daily test leaderboard
      const results = await Result.find({
        testId: test._id,
        phase: "GS",
        isLate: false
      })
        .sort({ score: -1, submittedAt: 1 })
        .limit(50)
        .lean();

      const total = await Result.countDocuments({
        testId: test._id,
        phase: "GS",
        isLate: false
      });

      return res.json({
        phase: "GS",
        leaderboard: results.map(r => ({
          userId: r.userId,
          score: Math.round(r.score * 100) / 100,
          submittedAt: r.submittedAt
        })),
        totalRankedParticipants: total,
        note: "Only on-time GS attempts"
      });
    }

    // Sunday full test → return both phases + combined
    const gsResults = await Result.find({ testId: test._id, phase: "GS", isLate: false })
      .sort({ score: -1, submittedAt: 1 })
      .limit(20)
      .lean();

    const csatResults = await Result.find({ testId: test._id, phase: "CSAT", isLate: false })
      .sort({ score: -1, submittedAt: 1 })
      .limit(20)
      .lean();

    // Combined leaderboard (top users by total score)
    const combined = await Result.aggregate([
      { $match: { testId: test._id, isLate: false, phase: { $in: ["GS", "CSAT"] } } },
      { $group: {
          _id: "$userId",
          totalScore: { $sum: "$score" },
          gsScore: { $sum: { $cond: [{ $eq: ["$phase", "GS"] }, "$score", 0] } },
          csatScore: { $sum: { $cond: [{ $eq: ["$phase", "CSAT"] }, "$score", 0] } }
        }},
      { $sort: { totalScore: -1 } },
      { $limit: 20 }
    ]);

    res.json({
      isSundayFullTest: true,
      gs: {
        leaderboard: gsResults.map(r => ({ userId: r.userId, score: Math.round(r.score*100)/100 })),
        total: await Result.countDocuments({ testId: test._id, phase: "GS", isLate: false })
      },
      csat: {
        leaderboard: csatResults.map(r => ({ userId: r.userId, score: Math.round(r.score*100)/100 })),
        total: await Result.countDocuments({ testId: test._id, phase: "CSAT", isLate: false })
      },
      combined: {
        leaderboard: combined.map((entry, idx) => ({
          rank: idx + 1,
          userId: entry._id,
          totalScore: Math.round(entry.totalScore * 100) / 100,
          gs: Math.round(entry.gsScore * 100) / 100,
          csat: Math.round(entry.csatScore * 100) / 100
        })),
        totalUniqueParticipants: await Result.distinct("userId", {
          testId: test._id,
          isLate: false,
          phase: { $in: ["GS", "CSAT"] }
        }).then(arr => arr.length)
      }
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
      return res.status(404).json({ message: "Test not found or not paid" });
    }

    const phase = req.query.phase || "GS"; // optional ?phase=CSAT

    let filter = { userId: req.user.uid, testId: test._id };
    if (test.isSundayFullTest) {
      filter.phase = phase;
    }

    const result = await Result.findOne(filter);
    if (!result) {
      return res.status(404).json({ message: `No submission found for phase ${phase}` });
    }

    let qFilter = { testId: test._id };
    if (test.isSundayFullTest) {
      qFilter.phase = phase;
    }

    const questions = await Question.find(qFilter)
      .sort({ questionNumber: 1 })
      .lean();

    const reviewQuestions = questions.map(q => {
      const userAns = result.answers.find(a => a.questionId === q._id.toString());
      return {
        questionNumber: q.questionNumber,
        questionStatement: q.questionStatement,
        options: q.options,
        yourAnswer: userAns?.selectedOption || null,
        correctAnswer: q.correctOption,
        isCorrect: userAns ? userAns.selectedOption === q.correctOption : false
      };
    });

    let rankInfo = null;
    if (!result.isLate) {
      const better = await Result.countDocuments({
        testId: test._id,
        phase: result.phase,
        isLate: false,
        $or: [
          { score: { $gt: result.score } },
          { score: result.score, submittedAt: { $lt: result.submittedAt } }
        ]
      });
      const total = await Result.countDocuments({
        testId: test._id,
        phase: result.phase,
        isLate: false
      });
      rankInfo = {
        phase: result.phase,
        score: Math.round(result.score * 100) / 100,
        rank: better + 1,
        totalParticipants: total
      };
    }

    res.json({
      title: test.title,
      phase: result.phase,
      score: Math.round(result.score * 100) / 100,
      correct: result.correct,
      incorrect: result.incorrect,
      unattempted: result.unattempted,
      submittedAt: result.submittedAt,
      isLate: result.isLate,
      rankInfo,
      questions: reviewQuestions,
      message: result.isLate
        ? "Late attempt – shown for review/practice only (no rank)"
        : "Review your answers and performance"
    });
  } catch (err) {
    console.error("/user/review-test error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

app.get("/free/tests", async (req, res) => {
  try {
    await connectDB();

    const tests = await Test.find({ testType: "free" })
      .sort({ createdAt: -1 })
      .select("title date totalQuestions startTime endTime createdAt")
      .lean();

    if (!tests.length) {
      return res.status(404).json({ message: "No free tests available" });
    }

    const IST_OFFSET = 5.5 * 60 * 60 * 1000;

    const formatted = tests.map(t => ({
      testId: t._id.toString(),
      title: t.title || "BPSC Free Practice Test",
      date: t.date || "—",
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

app.get("/free/test/:testId", async (req, res) => {
  try {
    await connectDB();

    const test = await Test.findOne({ _id: req.params.testId, testType: "free" }).lean();
    if (!test) {
      return res.status(404).json({ message: "Free test not found" });
    }

    const questions = await Question.find({ testId: test._id })
      .select("-correctOption")
      .lean();

    const IST_OFFSET = 5.5 * 60 * 60 * 1000;

    res.json({
      status: "active",
      testId: test._id.toString(),
      title: test.title || "BPSC Free Practice Test",
      totalQuestions: test.totalQuestions,
      date: test.date,
      questions,
      note: "Persistent free practice test — available anytime until removed by admin",
      isPersistentFreeTest: true
    });
  } catch (err) {
    console.error("/free/test/:testId error:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// Legacy endpoint – kept for backward compatibility, now always returns newest free test as active
app.get("/free/today-test", async (req, res) => {
  try {
    await connectDB();

    const test = await Test.findOne({ testType: "free" })
      .sort({ createdAt: -1 })
      .lean();

    if (!test) {
      return res.status(404).json({ message: "No free test available at the moment" });
    }

    const questions = await Question.find({ testId: test._id })
      .select("-correctOption")
      .lean();

    const IST_OFFSET = 5.5 * 60 * 60 * 1000;

    res.json({
      status: "active",
      testId: test._id.toString(),
      title: test.title || "BPSC Free Practice Test",
      totalQuestions: test.totalQuestions,
      date: test.date,
      questions,
      note: "Persistent free practice test — available anytime until removed by admin",
      isPersistentFreeTest: true
    });
  } catch (err) {
    console.error("/free/today-test error:", err.message);
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
