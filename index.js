const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const admin = require("firebase-admin");

const app = express();

// ================= SECURITY =================
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

// ================= DATABASE =================
let cached = global.mongoose;
if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function connectDB() {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = mongoose.connect(process.env.MONGO_URI)
      .then((mongoose) => {
        console.log("User DB Connected");
        return mongoose;
      });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

connectDB();

// ================= FIREBASE INIT =================
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    )
  });
}

// ================= SCHEMAS =================
const testSchema = new mongoose.Schema({
  title: String,
  date: String,
  totalQuestions: Number
}, { timestamps: true });

const questionSchema = new mongoose.Schema({
  testId: mongoose.Schema.Types.ObjectId,
  questionNumber: Number,
  questionStatement: String,
  options: Object,
  correctOption: String
});

const resultSchema = new mongoose.Schema({
  userId: String,
  testId: mongoose.Schema.Types.ObjectId,
  score: Number,
  totalQuestions: Number,
  startedAt: Date,
  submittedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Prevent duplicate attempt
resultSchema.index({ userId: 1, testId: 1 }, { unique: true });

const Test = mongoose.models.Test || mongoose.model("Test", testSchema);
const Question = mongoose.models.Question || mongoose.model("Question", questionSchema);
const Result = mongoose.models.Result || mongoose.model("Result", resultSchema);

// ================= FIREBASE AUTH =================
const userAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ message: "No token" });

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : authHeader;

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid Firebase token" });
  }
};

// ================= ROUTES =================
app.get("/", (req, res) => {
  res.json({ status: "User Backend Running" });
});

// GET TODAY TEST (24 HOUR MODEL)
app.get("/user/today-test", userAuth, async (req, res) => {
  await connectDB();

  const today = new Date().toISOString().split("T")[0];
  const test = await Test.findOne({ date: today });

  if (!test)
    return res.status(404).json({ message: "No test today" });

  const alreadyAttempted = await Result.findOne({
    userId: req.user.uid,
    testId: test._id
  });

  if (alreadyAttempted)
    return res.status(400).json({ message: "Already attempted today" });

  // Create attempt lock
  await Result.create({
    userId: req.user.uid,
    testId: test._id,
    score: 0,
    totalQuestions: test.totalQuestions,
    startedAt: new Date()
  });

  const questions = await Question.find({ testId: test._id })
    .select("-correctOption");

  res.json({
    testId: test._id,
    title: test.title,
    totalQuestions: test.totalQuestions,
    questions
  });
});

// SUBMIT TEST (60 MIN VALIDATION)
app.post("/user/submit-test/:testId", userAuth, async (req, res) => {
  await connectDB();

  const { answers } = req.body;

  const attempt = await Result.findOne({
    userId: req.user.uid,
    testId: req.params.testId
  });

  if (!attempt)
    return res.status(400).json({ message: "Test not started" });

  const diffMinutes =
    (new Date() - attempt.startedAt) / (1000 * 60);

  if (diffMinutes > 60)
    return res.status(400).json({ message: "Time expired" });

  const questions = await Question.find({
    testId: req.params.testId
  });

  let score = 0;

  questions.forEach((q) => {
    const userAnswer = answers.find(
      (a) => a.questionId === q._id.toString()
    );

    if (userAnswer && userAnswer.selectedOption === q.correctOption)
      score++;
  });

  attempt.score = score;
  attempt.submittedAt = new Date();
  await attempt.save();

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
});

// LEADERBOARD
app.get("/user/leaderboard/:testId", async (req, res) => {
  await connectDB();

  const topUsers = await Result.find({
    testId: req.params.testId
  })
    .sort({ score: -1, submittedAt: 1 })
    .limit(50);

  res.json(topUsers);
});

module.exports = app;
