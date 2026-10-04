import { pdf } from "pdf-to-img";
import { z } from "zod";
import {
  loadGradingConfig,
  type GradeResult,
  type GradingConfig
} from "@ai-grader/shared";

const gradingInputSchema = z.object({
  path: z.string().trim().min(1),
  rubric: z.string().trim().min(1)
});

const gradeResultSchema = z.object({
  score: z.number().finite().nonnegative(),
  feedback: z.array(z.string().trim().min(1))
}).strict();

const openRouterResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.union([
          z.string(),
          z.array(
            z.object({
              type: z.string(),
              text: z.string().optional()
            }).passthrough()
          )
        ])
      })
    })
  ).min(1)
});

type OpenRouterMessage = {
  role: "system" | "user";
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
};

async function renderPdfPages(path: string): Promise<string[]> {
  const document = await pdf(path, { scale: 2, format: "png" });

  try {
    const pages: string[] = [];

    for await (const image of document) {
      pages.push(`data:image/png;base64,${image.toString("base64")}`);
    }

    if (pages.length === 0) {
      throw new Error("The PDF does not contain any pages");
    }

    return pages;
  } finally {
    await document.destroy();
  }
}

function buildMessages(rubric: string, images: string[], retry: boolean): OpenRouterMessage[] {
  const retryInstruction = retry
    ? " Your previous response was invalid. Return a valid JSON object matching the required shape."
    : "";

  return [
    {
      role: "system",
      content:
        "Grade the answer sheet using the supplied rubric. Return only a JSON object with a numeric score and a feedback array of strings. Do not include markdown fences or additional fields."
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Rubric:\n${rubric}\n\nReturn JSON with exactly this shape: {"score": 0, "feedback": ["..."]}.${retryInstruction}`
        },
        ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))
      ]
    }
  ];
}

async function requestGrade(
  config: GradingConfig,
  rubric: string,
  images: string[],
  retry: boolean
): Promise<string> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.OPENROUTER_MODEL,
      temperature: 0,
      messages: buildMessages(rubric, images, retry)
    }),
    signal: AbortSignal.timeout(60_000)
  });

  if (!response.ok) {
    throw new Error(`OpenRouter grading request failed with HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  const result = openRouterResponseSchema.safeParse(payload);

  if (!result.success) {
    throw new Error("OpenRouter returned an unexpected response shape");
  }

  const content = result.data.choices[0]?.message.content;
  if (content === undefined) {
    throw new Error("OpenRouter response did not include message content");
  }

  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function parseGradeResponse(content: string): GradeResult | undefined {
  const json = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let candidate: unknown;

  try {
    candidate = JSON.parse(json);
  } catch {
    return undefined;
  }

  const result = gradeResultSchema.safeParse(candidate);
  return result.success ? result.data : undefined;
}

export async function gradePdf(path: string, rubric: string): Promise<GradeResult> {
  const input = gradingInputSchema.parse({ path, rubric });
  const config = loadGradingConfig();
  const images = await renderPdfPages(input.path);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const content = await requestGrade(config, input.rubric, images, attempt === 1);
    const result = parseGradeResponse(content);

    if (result) {
      return result;
    }
  }

  throw new Error("OpenRouter returned invalid grade JSON after one retry");
}
