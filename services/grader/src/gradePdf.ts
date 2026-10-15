import { pdf } from "pdf-to-img";
import { z } from "zod";
import {
  loadGradingConfig,
  type GradeResult,
  type GradingConfig
} from "@ai-grader/shared";
import { generateGeminiGradeText } from "./geminiClient.js";

const gradingInputSchema = z.object({
  path: z.string().trim().min(1),
  rubric: z.string().trim().min(1)
});

const gradeResultSchema = z.object({
  score: z.number().finite().nonnegative(),
  feedback: z.array(z.string().trim().min(1))
}).strict();

async function renderPdfPages(path: string): Promise<string[]> {
  const document = await pdf(path, { scale: 2, format: "png" });

  try {
    const pages: string[] = [];

    for await (const image of document) {
      pages.push(image.toString("base64"));
    }

    if (pages.length === 0) {
      throw new Error("The PDF does not contain any pages");
    }

    return pages;
  } finally {
    await document.destroy();
  }
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

export async function gradeRenderedPages(
  config: GradingConfig,
  rubric: string,
  images: string[],
  fetchImplementation: typeof fetch = fetch
): Promise<GradeResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const content = await generateGeminiGradeText(
      config,
      rubric,
      images,
      attempt === 1,
      fetchImplementation
    );
    const result = parseGradeResponse(content);

    if (result) {
      return result;
    }
  }

  throw new Error("Gemini returned invalid grade JSON after one retry");
}

export async function gradePdf(path: string, rubric: string): Promise<GradeResult> {
  const input = gradingInputSchema.parse({ path, rubric });
  const config = loadGradingConfig();
  const images = await renderPdfPages(input.path);
  return gradeRenderedPages(config, input.rubric, images);
}
