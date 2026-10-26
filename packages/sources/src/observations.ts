import { createHash } from "node:crypto";
export interface Observation {
  record_id: string;
  geoid: string | null;
  entity_key: string;
  event_date: string | null;
  year: number | null;
  month: number | null;
  category: string;
  value: number | null;
  value_kind: string;
}
export function observation(
  id: string,
  geoid: string | null,
  fields: {
    date?: string | null;
    year?: string | null;
    month?: string | null;
    category?: string | null;
    value?: string | null;
    entity?: string | null;
    entityLocation?: string | null;
    valueKind?: string;
  },
): Observation {
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  const raw = fields.date;
  const date = raw == null || raw === "" ? undefined : new Date(/^\d{12,13}$/.test(raw) ? Number(raw) : raw);
  const valid = date && Number.isFinite(date.getTime());
  const year = valid
    ? date.getUTCFullYear()
    : fields.year && /^\d{4}$/.test(fields.year)
      ? Number(fields.year)
      : null;
  const names = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const month = valid
    ? date.getUTCMonth() + 1
    : fields.month && /^\d+/.test(fields.month)
      ? parseInt(fields.month, 10)
      : fields.month
        ? names.findIndex((n) => fields.month!.toLowerCase().includes(n)) + 1
        : null;
  const key = fields.entity?.trim()
    ? `${fields.entity.trim().toLowerCase()}|${fields.entityLocation?.trim().toLowerCase() ?? ""}`
    : id;
  const value =
    fields.value === undefined
      ? (fields.valueKind ?? "count") === "count"
        ? 1
        : null
      : fields.value == null || fields.value.trim() === ""
        ? null
        : Number(fields.value);
  return {
    record_id: hash(id),
    geoid,
    entity_key: hash(key),
    event_date: valid ? date.toISOString() : null,
    year,
    month: month && month >= 1 && month <= 12 ? month : null,
    category: fields.category?.trim() || "Unknown",
    value: value != null && Number.isFinite(value) ? value : null,
    value_kind: fields.valueKind ?? "count",
  };
}

export function observationRoles(
  fields: { name: string; type?: string }[],
  hasGeometry: boolean,
  groupField?: string,
) {
  const dateField = fields.find((f) => /^(IssuedDate|Create_Date|CaseDate|Date)$/i.test(f.name))?.name;
  const yearField = fields.find((f) => /^year$/i.test(f.name))?.name,
    monthField = fields.find((f) => /^month$/i.test(f.name))?.name;
  const categoryField =
    groupField ??
    fields.find((f) => /^(Request_Type|CaseType|Call_Category|PermitCode|TYPE)$/i.test(f.name))?.name;
  const geocoded = fields.some((f) => /^Match_type$/i.test(f.name));
  const valueField = geocoded
    ? fields.find((f) => /^Score_1$/i.test(f.name))?.name
    : !hasGeometry
      ? fields.find((f) => /^Call_Count_By_Origin$/i.test(f.name))?.name
      : undefined;
  const valueKind = valueField && /score/i.test(valueField) ? "score" : "count";
  const entityField =
    valueKind === "score" ? fields.find((f) => /^Establishment$/i.test(f.name))?.name : undefined;
  const entityLocationField = entityField ? fields.find((f) => /^Address$/i.test(f.name))?.name : undefined;
  return {
    dateField,
    yearField,
    monthField,
    categoryField,
    valueField,
    valueKind,
    entityField,
    entityLocationField,
  };
}
