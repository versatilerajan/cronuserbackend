const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use(cors());
app.use(helmet());
app.use(compression());

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500
  })
);

/* ================= DATABASE (SERVERLESS SAFE) ================= */

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function connectDB() {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = mongoose.connect(process.env.MONGO_URI, {
      bufferCommands: false,
      maxPoolSize: 5
    }).then((mongoose) => {
      console.log("User DB Connected");
      return mongoose;
    });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

/* ================= FIREBASE INIT ================= */

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    })
  });
}

/* ================= SCHEMAS ================= */

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

/* ================= FIREBASE AUTH ================= */

const userAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader)
      return res.status(401).json({ message: "No token provided" });

    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : authHeader;

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;

    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid Firebase token" });
  }
};

/* ================= ROUTES ================= */

// Root route
app.get("/", async (req, res) => {
  res.json({ status: "User Backend Running" });
});

// GET TODAY TEST
app.get("/user/today-test", userAuth, async (req, res) => {
  try {
    await connectDB();

    const today = new Date().toISOString().split("T")[0];
    const test = await Test.findOne({ date: today });

    if (!test)
      return res.status(404).json({ message: "No test today" });

    const now = new Date();

    if (now < test.startTime)
      return res.json({ status: "not_started" });

    if (now > test.endTime)
      return res.json({ status: "ended" });

    const questions = await Question.find({ testId: test._id })
      .select("-correctOption");

    res.json({
      status: "active",
      testId: test._id,
      title: test.title,
      totalQuestions: test.totalQuestions,
      questions
    });

  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// SUBMIT TEST
app.post("/user/submit-test/:testId", userAuth, async (req, res) => {
  try {
    await connectDB();

    const { answers } = req.body;

    if (!answers || !Array.isArray(answers))
      return res.status(400).json({ message: "Invalid answers format" });

    const questions = await Question.find({
      testId: req.params.testId
    });

    let score = 0;

    questions.forEach((q) => {
      const userAnswer = answers.find(
        (a) => a.questionId === q._id.toString()
      );

      if (userAnswer && userAnswer.selectedOption === q.correctOption) {
        score++;
      }
    });

    const alreadySubmitted = await Result.findOne({
      userId: req.user.uid,
      testId: req.params.testId
    });

    if (alreadySubmitted)
      return res.status(400).json({ message: "Already submitted" });

    await Result.create({
      userId: req.user.uid,
      testId: req.params.testId,
      score,
      totalQuestions: questions.length
    });

    const rank =
      (await Result.countDocuments({
        testId: req.params.testId,
        score: { $gt: score }
      })) + 1;

    res.json({
      score,
      totalQuestions: questions.length,
      rank
    });

  } catch (err) {
    res.status(500).json({ message: "Submission failed" });
  }
});

// LEADERBOARD
app.get("/user/leaderboard/:testId", async (req, res) => {
  try {
    await connectDB();

    const topUsers = await Result.find({
      testId: req.params.testId
    })
      .sort({ score: -1, submittedAt: 1 })
      .limit(50);

    res.json(topUsers);

  } catch (err) {
    res.status(500).json({ message: "Leaderboard error" });
  }
});

module.exports = app;
