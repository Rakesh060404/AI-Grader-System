import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeRenderedPages } from "../dist/gradePdf.js";
import { generateGeminiGradeText } from "../dist/geminiClient.js";

const config = {
  GEMINI_API_KEY: "test-api-key",
  GEMINI_MODEL: "test-vision-model"
};

function createResponse(text, status = 200) {
  return new Response(
    JSON.stringify({
      candidates: [{
        content: {
          parts: [{ text }]
        },
        finishReason: "STOP"
      }]
    }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

test("Gemini request sends rubric and rendered pages with structured JSON output", async () => {
  let request;
  const fetchStub = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return createResponse('{"score":8,"feedback":["Good work"]}');
  };

  const response = await generateGeminiGradeText(
    config,
    "Award points for correct reasoning.",
    ["cGFnZS1pbWFnZQ=="],
    false,
    fetchStub
  );

  assert.equal(response, '{"score":8,"feedback":["Good work"]}');
  assert.equal(
    request.url,
    "https://generativelanguage.googleapis.com/v1beta/models/test-vision-model:generateContent"
  );
  assert.equal(request.options.headers["x-goog-api-key"], "test-api-key");
  assert.match(request.body.contents[0].parts[0].text, /Award points for correct reasoning/);
  assert.deepEqual(request.body.contents[0].parts[1], {
    inlineData: { mimeType: "image/png", data: "cGFnZS1pbWFnZQ==" }
  });
  assert.equal(request.body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(request.body.generationConfig.responseSchema.required, ["score", "feedback"]);
});

test("Gemini HTTP errors are reported with their status", async () => {
  await assert.rejects(
    generateGeminiGradeText(config, "rubric", ["image"], false, async () => new Response("", {
      status: 429
    })),
    /Gemini grading request failed with HTTP 429/
  );
});

test("invalid JSON is retried once, then validated before returning", async () => {
  const requests = [];
  const responses = [
    createResponse("not json"),
    createResponse('{"score":9,"feedback":["Clear explanation"]}')
  ];
  const fetchStub = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return responses.shift();
  };

  const result = await gradeRenderedPages(config, "rubric", ["image"], fetchStub);

  assert.deepEqual(result, { score: 9, feedback: ["Clear explanation"] });
  assert.equal(requests.length, 2);
  assert.match(requests[1].contents[0].parts[0].text, /previous response was invalid/i);
});

test("a second invalid grade response fails instead of returning an unvalidated result", async () => {
  const fetchStub = async () => createResponse('{"score":"nine","feedback":[]}');

  await assert.rejects(
    gradeRenderedPages(config, "rubric", ["image"], fetchStub),
    /Gemini returned invalid grade JSON after one retry/
  );
});
