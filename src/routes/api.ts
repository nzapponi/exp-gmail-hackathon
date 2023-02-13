import debug from "debug";
import express from "express";
import { Credentials } from "google-auth-library";
import { google } from "googleapis";
import { Configuration, OpenAIApi } from "openai";

import { goodResponse } from "../utils/utils";

const log = debug("server:api");

const router = express.Router();

type AuthToken = {
  provider: "google" | "other";
  userId: string;
  tokens: Credentials;
  lastChecked: number;
};

type SuggestedExpense = {
  userId: string;
  emailId: string;
  vendor?: string;
  amount?: number;
  currency?: string;
  description?: string;
  attachment?: string;
  dismissed?: boolean;
};

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URL = process.env.GOOGLE_REDIRECT_URL;
const OPENAI_TOKEN = process.env.OPENAI_TOKEN;

const GOOGLE_REQUESTED_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
];
const ALLOWED_EMAILS = [
  "auto-confirm@amazon.co.uk",
  // "noreply@uber.com"
];
const EMAILS_TO_VENDORS: { [email: string]: string } = {
  "auto-confirm@amazon.co.uk": "Amazon UK",
  // "noprely@uber.com": "Uber",
};
const authTokens: AuthToken[] = [];
const suggestedExpenses: SuggestedExpense[] = [];

// *************************

const openAiConfig = new Configuration({ apiKey: OPENAI_TOKEN });
const openAi = new OpenAIApi(openAiConfig);

const googleOauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URL
);

const getGoogleAuthUrl = async (userId: string) => {
  const url = googleOauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: GOOGLE_REQUESTED_SCOPES,
    state: userId,
  });
  return url;
};

const completeEnrollmentGoogle = async (userId: string, code: string) => {
  const { tokens } = await googleOauth2Client.getToken(code);
  // check if one exists already
  const existingTokenIndex = authTokens.findIndex(
    (t) => t.userId === userId && t.provider === "google"
  );
  if (existingTokenIndex > -1) {
    authTokens[existingTokenIndex].tokens = tokens;
  } else {
    authTokens.push({
      userId,
      provider: "google",
      tokens,
      lastChecked: 1675277947,
      // lastChecked: Math.floor(Date.now() / 1000),
    });
  }
  log(
    `Stored token for user ${userId}: ${tokens.access_token}, ${tokens.refresh_token}`
  );
};

const getGmailClientForUser = (authToken: AuthToken) => {
  const authClient = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URL
  );
  authClient.setCredentials(authToken.tokens);
  const gmail = google.gmail({
    version: "v1",
    auth: authClient,
  });
  return gmail;
};

const aiParseEmailContent = async (content: string) => {
  const result = await openAi.createCompletion({
    model: "text-curie-001",
    prompt: `Read this email and then answer the following questions:\n"""\n${content}\n"""\nQuestions:\n1.Total price?\n2.Currency (ISO code)?\n3.Description of the order?\n\nAnswers:\n1.`,
    temperature: 0,
    max_tokens: 64,
  });
  const text = result.data.choices[0].text;
  const textParts = text.split("\n");

  const amountRegex = /([0-9\.]+)$/;
  const amount = amountRegex.exec(textParts[0].trim())[1];
  const currencyRegex = /([A-Z]+)/;
  const currency = currencyRegex.exec(textParts[1].trim())[1];
  const description = textParts[2].slice(3);

  return { amount: +amount, currency, description };
};

const processEmail = async (
  authToken: AuthToken,
  id: string
): Promise<SuggestedExpense | null> => {
  // 1. Get email contents
  const gmail = getGmailClientForUser(authToken);
  const gmailResponse = await gmail.users.messages.get({ id, userId: "me" });
  const emailPayload = gmailResponse.data.payload;
  if (emailPayload) {
    let textPayload: string | null = null;
    if (emailPayload.parts) {
      const textPart = emailPayload.parts.find(
        (part) => part.mimeType === "text/plain"
      );
      if (textPart) {
        textPayload = Buffer.from(textPart.body.data, "base64").toString(
          "utf-8"
        );
      }
    }
    if (!textPayload) {
      textPayload = Buffer.from(emailPayload.body.data, "base64").toString(
        "utf-8"
      );
    }
    log(textPayload);

    if (textPayload) {
      const parsedData = await aiParseEmailContent(textPayload);
      if (parsedData.amount && parsedData.currency && parsedData.description) {
        const mailFrom = gmailResponse.data.payload.headers.find(
          (h) => h.name === "From"
        );
        return {
          ...parsedData,
          vendor: EMAILS_TO_VENDORS[mailFrom.value.split("<")[1].split(">")[0]],
          userId: authToken.userId,
          emailId: id,
        };
      }
    }

    // let htmlPayload: string | null = null;
    // const htmlPart = emailPayload.parts.find((part) => part.mimeType === "text/html");
    // if (htmlPart) {
    //   htmlPayload = Buffer.from(htmlPart.body.data, "base64").toString("utf-8");
    // } else {
    //   htmlPayload = Buffer.from(emailPayload.body.data, "base64").toString("utf-8");
    // }

    // if (htmlPayload) {
    //   const $ = cheerio.load(htmlPayload);
    //   const total = $("td.total-value").text();
    //   log(total);
    //   // 2. Parse email

    //   // 3. Return suggested expense & attachment or nothing
    // }
  }
  return null;
};

const getLatestEmailsForUser = async (authToken: AuthToken) => {
  log(`Getting emails for user ${authToken.userId}...`);
  const gmail = getGmailClientForUser(authToken);
  const gmailResponse = await gmail.users.messages.list({
    userId: "me",
    q: `from:{${ALLOWED_EMAILS.join(" ")}} after:${authToken.lastChecked}`,
  });
  const messages = gmailResponse.data.messages;
  const suggestedExpenses: SuggestedExpense[] = [];
  if (messages) {
    log(`Found ${messages.length} messages...`);
    for (const message of messages) {
      const suggestedExpense = await processEmail(authToken, message.id);
      if (suggestedExpense) {
        suggestedExpenses.push(suggestedExpense);
      }
    }
  } else {
    log("No messages found");
  }

  authToken.lastChecked = Math.floor(Date.now() / 1000);

  return suggestedExpenses;
};

router.post("/enrol/google", async (req, res, next) => {
  let { userId } = req.body as { userId?: string };
  if (!userId) {
    userId = "1234567890";
  }

  try {
    const authUrl = await getGoogleAuthUrl(userId);
    res.json(
      goodResponse({
        authUrl,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.get("/enrol/google/callback", async (req, res, next) => {
  const { code, state } = req.query as { code: string; state: string };
  try {
    const userId = state;
    await completeEnrollmentGoogle(userId, code);
    res.json(goodResponse({}));
  } catch (err) {
    next(err);
  }
});

router.get("/sync", async (req, res) => {
  for (const authToken of authTokens) {
    const newExpenses = await getLatestEmailsForUser(authToken);
    if (newExpenses.length > 0) {
      suggestedExpenses.push(
        ...newExpenses.filter(
          (exp) => !suggestedExpenses.some((s) => s.emailId === exp.emailId)
        )
      );
    }
  }
  res.json(goodResponse({}));
});

router.get("/suggestions", (req, res) => {
  let { userId } = req.query as { userId?: string };
  if (!userId) {
    userId = "1234567890";
  }
  const userExpenses = suggestedExpenses.filter(
    (e) => e.userId === userId && e.dismissed !== true
  );
  res.json({
    suggestions: userExpenses,
  });
});

router.delete("/suggestion/:suggestionId", (req, res) => {
  const { suggestionId } = req.params;
  const expIndex = suggestedExpenses.findIndex(
    (e) => e.emailId === suggestionId
  );
  if (expIndex > -1) {
    suggestedExpenses[expIndex].dismissed = true;
  }
  res.sendStatus(200);
});

export default router;
