export type NoticeCode =
  | "OUT_OF_SCOPE"
  | "NO_SOURCE"
  | "SOURCE_DOWN"
  | "SOURCE_REPAIRED"
  | "JOIN_WEAK"
  | "SMALL_SAMPLE"
  | "MODEL_SLOW"
  | "MODEL_DOWN"
  | "ZETARIS_DOWN"
  | "PARTIAL";
export function notice(
  code: NoticeCode,
  detail: string | { source: string; reason: string },
): {
  code: NoticeCode;
  message: string;
} {
  const sentences: Record<NoticeCode, string> = {
    OUT_OF_SCOPE:
      "Fieldwork answers questions about Montgomery, AL from city, CDC and census data. This question needs",
    NO_SOURCE: "No suitable public dataset was found for",
    SOURCE_DOWN: "A data source is not answering right now. Retry this question or choose another source.",
    SOURCE_REPAIRED: "The source request failed; a retry restored the connection.",
    JOIN_WEAK: "Too few records matched a neighborhood. Showing the result with that warning.",
    SMALL_SAMPLE: "Fewer than 30 records support a group. Treat that number with care.",
    MODEL_SLOW: "The model is taking longer than usual. Still working.",
    MODEL_DOWN: "The model provider failed; a fallback answered.",
    ZETARIS_DOWN: "The data layer is not answering. Open a recorded answer from History while it recovers.",
    PARTIAL:
      "I could not fully support an answer after the checks. Here is what the data shows and what remains uncertain.",
  };
  if (typeof detail !== "string") return { code, message: `${detail.source} ${detail.reason}` };
  return { code, message: `${sentences[code]} ${detail}`.trim() };
}
export class FieldworkError extends Error {
  constructor(
    readonly code: NoticeCode,
    detail: string | { source: string; reason: string },
  ) {
    super(notice(code, detail).message);
  }
}
