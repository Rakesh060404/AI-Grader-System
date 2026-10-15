import { z } from "zod";
import type { GradingConfig } from "@ai-grader/shared";

const geminiResponseSchema = z.object({
  candidates: z.array(
    z.object({
      content: z.object({
        parts: z.array(
          z.object({
            text: z.string().optional()
          }).passthrough()
        )
      }).optional(),
      finishReason: z.string().optional()
    }).passthrough()
  )
}).passthrough();

const gradeJsonSchema = {
  type: "OBJECT",
  properties: {
    score: { type: "NUMBER" },
    feedback: {
      type: "ARRAY",
      items: { type: "STRING" }
    }
  },
  required: ["score", "feedback"]
};

export async function generateGeminiGradeText(
  config: GradingConfig,
  rubric: string,
  images: string[],
  retry: boolean,
  fetchImplementation: typeof fetch = fetch
): Promise<string> {
  const retryInstruction = retry
    ? " Your previous response was invalid. Return a valid JSON object matching the required schema."
    : "";
  const model = encodeURIComponent(config.GEMINI_MODEL);
  const response = await fetchImplementation(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: "Grade the answer sheet using the supplied rubric. Return a JSON object with a numeric score and a feedback array of strings. Do not add fields."
          }]
        },
        contents: [{
          role: "user",
          parts: [
            {
              text: `Rubric:\n${rubric}\n\nReturn JSON with exactly this shape: {"score": 0, "feedback": ["..."]}.${retryInstruction}`
            },
            ...images.map((data) => ({
              inlineData: {
                mimeType: "image/png",
                data
              }
            }))
          ]
        }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: gradeJsonSchema
        }
      }),
      signal: AbortSignal.timeout(60_000)
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini grading request failed with HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  const result = geminiResponseSchema.safeParse(payload);
  if (!result.success) {
    throw new Error("Gemini returned an unexpected response shape");
  }

  const candidate = result.data.candidates[0];
  if (!candidate?.content) {
    const reason = candidate?.finishReason;
    throw new Error(
      reason
        ? `Gemini did not return grade content (finish reason: ${reason})`
        : "Gemini response did not include grade content"
    );
  }

  const text = candidate.content.parts
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");

  if (!text) {
    throw new Error("Gemini response did not include grade text");
  }
  return text;
}
