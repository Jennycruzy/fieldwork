import { createHash } from "node:crypto";
export function normalizeName(s: string): string { return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim(); }
export function entityIdFromName(type: string, name: string): string { return `ent_${createHash("sha256").update(`${type}:${normalizeName(name)}`).digest("hex").slice(0, 16)}`; }
export function decide(similarity: number): "auto-merge" | "review" | "new" { return similarity >= .85 ? "auto-merge" : similarity >= .82 ? "review" : "new"; }
function canonical(v: unknown): string { if (Array.isArray(v))
    return `[${v.map(canonical).join(",")}]`; if (v && typeof v === "object")
    return `{${Object.entries(v).filter(([, value])=>value!==undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`; return JSON.stringify(v) ?? "null"; }
export interface Source {
    kind: string;
    at: string;
    [key: string]: unknown;
}
export interface Entity {
    id: string;
    type: string;
    name?: string;
    attrs: Record<string, unknown>;
    source: Source;
}
export interface Edge {
    id: string;
    from: string;
    to: string;
    type: string;
    context?: string;
    validFrom: string;
    validTo?: string;
    supersededBy?: string;
    source: Source;
}
export interface Entry {
    seq: number;
    action: "entity" | "context" | "edge" | "observation";
    value: Entity | Edge | Record<string, unknown>;
    source: Source;
}
interface Options {
    storage?: string;
    namespace?: string;
    clock?: () => Date;
    entries?: Entry[];
    append?: (e: Entry) => Promise<void>;
}
export class WorldModel {
    private log: Entry[];
    private queue: Promise<unknown> = Promise.resolve();
    constructor(private opts: Options = {}) { this.log = structuredClone(opts.entries ?? []); }
    private serial<T>(f: () => Promise<T>): Promise<T> { const task = this.queue.then(f); this.queue = task.catch(() => undefined); return task; }
    private provenance(s: Source) { if (!s?.kind || !s.at || !Number.isFinite(Date.parse(s.at)))
        throw new Error("Every world write needs dated provenance"); }
    private async append(action: Entry["action"], value: Entry["value"], source: Source) {
        this.provenance(source);
        const e: Entry = { seq: (this.log.at(-1)?.seq ?? 0) + 1, action, value: structuredClone(value), source: structuredClone(source) };
        await this.opts.append?.(e);
        this.log.push(e);
    }
    entities(): Entity[] { const m = new Map<string, Entity>(); for (const e of this.log)
        if (e.action === "entity" || e.action === "context")
            m.set(String(e.value.id), structuredClone(e.value as Entity)); return [...m.values()]; }
    edges(): Edge[] {
        const records=new Map<string,Edge>();
        for(const entry of this.log) if(entry.action === "edge") {
            const edge=structuredClone(entry.value as Edge);
            if(!edge.validTo) for(const old of records.values()) if(!old.validTo && old.from===edge.from && old.type===edge.type && old.context===edge.context && old.to!==edge.to && old.validFrom<=edge.validFrom) records.set(old.id,{...old,validTo:edge.validFrom,supersededBy:edge.id});
            records.set(edge.id,edge);
        }
        return [...records.values()];
    }
    get(id: string): Entity | undefined { return this.entities().find((x) => x.id === id); }
    private async put(x: {
        type: string;
        name?: string;
        externalKey?: {
            system: string;
            id: string;
        };
        attrs?: Record<string, unknown>;
        source: Source;
    }, action: "entity" | "context") {
        this.provenance(x.source);
        if (!x.externalKey && !x.name)
            throw new Error("An entity needs a name or an external key");
        const id = x.externalKey ? `${x.type}:${x.externalKey.system}:${x.externalKey.id}` : entityIdFromName(x.type, x.name!);
        const prev = this.get(id);
        const value: Entity = { id, type: x.type, name: x.name ?? prev?.name, attrs: { ...prev?.attrs, ...x.attrs }, source: x.source };
        if (canonical(prev) !== canonical(value))
            await this.append(action, value, x.source);
        return value;
    }
    upsertEntity(x: Parameters<WorldModel["put"]>[0]): Promise<Entity> { return this.serial(() => this.put(x, "entity")); }
    upsertContext(x: Parameters<WorldModel["put"]>[0]): Promise<Entity> { return this.serial(() => this.put(x, "context")); }
    relate(x: Omit<Edge, "id" | "validFrom"> & {
        validFrom?: string;
    }): Promise<Edge> {
        return this.serial(async () => {
            this.provenance(x.source);
            if (!this.get(x.from) || !this.get(x.to))
                throw new Error("Both edge endpoints must exist");
            const validFrom = x.validFrom ?? x.source.at;
            const id = createHash("sha256").update(canonical([x.from, x.type, x.to, x.context, validFrom])).digest("hex");
            const edge: Edge = { ...x, id, validFrom };
            for (const old of this.edges().filter((e) => e.from === x.from && e.type === x.type && e.context === x.context && !e.validTo && e.to !== x.to)) {
                if (validFrom < old.validFrom)
                    throw new Error("Superseding edges must follow the previous valid time");

            }
            if (!this.edges().some((e) => canonical(e) === canonical(edge)))
                await this.append("edge", edge, x.source);
            return edge;
        });
    }
    async ingest(observations: {
        externalId: string;
        title: string;
        at: string;
        source: Source;
        entities?: {
            type: string;
            name: string;
        }[];
    }[]) {
        const start = this.stateShapeCanonical();
        for (const o of observations)
            await this.serial(async () => {
                this.provenance(o.source);
                const latest = [...this.log].reverse().find((e) => e.action === "observation" && ("externalId" in e.value && e.value.externalId === o.externalId));
                if (latest && canonical(latest.value) === canonical(o))
                    return;
                for (const entity of o.entities ?? [])
                    await this.put({ ...entity, source: o.source }, "entity");
                await this.append("observation", o, o.source);
            });
        return { changed: start !== this.stateShapeCanonical() };
    }
    view(kind: string) {
        return { neighborsOf: (id: string, options: {
                via?: string;
                at?: string;
            } = {}) => {
                const at = options.at;
                const ids = this.edges().filter((e) => e.from === id && (!options.via || e.type === options.via) && (at ? e.validFrom <= at && (!e.validTo || at < e.validTo) : !e.validTo)).map((e) => e.to);
                return this.entities().filter((e) => ids.includes(e.id));
            }, entities: () => this.entities(), kind };
    }
    audit(): Entry[] { return structuredClone(this.log); }
    stateShapeCanonical(): string { return canonical({ version: 1, entities: this.entities(), edges: this.edges(), observations: this.log.filter((e) => e.action === "observation").map((e) => e.value) }); }
    context(): {
        entities: Entity[];
        edges: Edge[];
    } { return { entities: this.entities(), edges: this.edges() }; }
}
