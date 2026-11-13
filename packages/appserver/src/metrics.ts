/**
 * Minimal Prometheus text-format metrics registry.
 *
 * The appserver exposes a `/metrics` endpoint (Prometheus scrape) so the
 * observability stack can collect the signals that diagnose pool saturation
 * and N+1 bottlenecks: request latency by endpoint, DB pool queue depth per
 * worker, query-cache hit rate, embed backlog, and DB request timeouts.
 * Alloy scrapes it and remote-writes to Grafana Cloud Mimir (see
 * deploy/alloy/config.alloy).
 *
 * Deliberately dependency-free and synchronous: `render()` is a pure string
 * build, so the scrape path never touches a DB worker or the event loop.
 *
 * A registry may be given constant labels that every sample carries. They name
 * the process, not the series, so they are merged at render time and never
 * part of a sample's key: two samples that differ only in their declared
 * labels stay distinct samples that share the constant ones.
 */

export type LabelSet = Record<string, string>;

type FamilyType = "counter" | "gauge" | "histogram";

interface Family {
  name: string;
  help: string;
  type: FamilyType;
  labelNames: string[];
}

interface CounterFamily extends Family {
  type: "counter";
  values: Map<string, { labels: LabelSet; value: number }>;
}

interface GaugeFamily extends Family {
  type: "gauge";
  values: Map<string, { labels: LabelSet; value: number }>;
}

interface HistogramFamily extends Family {
  type: "histogram";
  buckets: number[];
  values: Map<string, { labels: LabelSet; counts: number[]; sum: number; count: number }>;
}

type AnyFamily = CounterFamily | GaugeFamily | HistogramFamily;

const DEFAULT_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

function labelKey(labelNames: string[], labels: LabelSet): string {
  return labelNames.map((n) => String(labels[n] ?? "")).join("\u0000");
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** `{name="value",…}`, or "" when there are no labels at all. */
function formatPairs(pairs: Array<[string, string]>): string {
  if (pairs.length === 0) return "";
  return `{${pairs.map(([n, v]) => `${n}="${v}"`).join(",")}}`;
}

export interface CounterHandle {
  inc(labels?: LabelSet, n?: number): void;
}
export interface GaugeHandle {
  set(labels: LabelSet, value: number): void;
  inc(labels?: LabelSet, n?: number): void;
}
export interface HistogramHandle {
  observe(labels: LabelSet, value: number): void;
}

export class Metrics {
  private families = new Map<string, AnyFamily>();
  /** Escaped once: constant for the lifetime of this process. */
  private readonly constantLabels: Array<[string, string]>;

  constructor(constantLabels: LabelSet = {}) {
    this.constantLabels = Object.entries(constantLabels).map(([n, v]) => [n, escapeLabel(v)]);
  }

  /**
   * The rendered labels of one sample: declared labels in declaration order,
   * then constant labels the family does not already declare.
   */
  private labelPairs(labelNames: string[], labels: LabelSet): Array<[string, string]> {
    const pairs: Array<[string, string]> = labelNames.map((n) => [n, escapeLabel(labels[n] ?? "")]);
    for (const [n, v] of this.constantLabels) {
      if (!labelNames.includes(n)) pairs.push([n, v]);
    }
    return pairs;
  }

  counter(name: string, help: string, labelNames: string[] = []): CounterHandle {
    const fam: CounterFamily = { name, help, type: "counter", labelNames, values: new Map() };
    this.families.set(name, fam);
    return {
      inc: (labels: LabelSet = {}, n = 1) => {
        const key = labelKey(labelNames, labels);
        const cur = fam.values.get(key);
        if (cur) cur.value += n;
        else fam.values.set(key, { labels, value: n });
      },
    };
  }

  gauge(name: string, help: string, labelNames: string[] = []): GaugeHandle {
    const fam: GaugeFamily = { name, help, type: "gauge", labelNames, values: new Map() };
    this.families.set(name, fam);
    return {
      set: (labels: LabelSet = {}, value: number) => {
        const key = labelKey(labelNames, labels);
        fam.values.set(key, { labels, value });
      },
      inc: (labels: LabelSet = {}, n = 1) => {
        const key = labelKey(labelNames, labels);
        const cur = fam.values.get(key);
        if (cur) cur.value += n;
        else fam.values.set(key, { labels, value: n });
      },
    };
  }

  histogram(
    name: string,
    help: string,
    labelNames: string[] = [],
    buckets: number[] = DEFAULT_BUCKETS,
  ): HistogramHandle {
    const fam: HistogramFamily = { name, help, type: "histogram", labelNames, buckets, values: new Map() };
    this.families.set(name, fam);
    return {
      observe: (labels: LabelSet = {}, value: number) => {
        const key = labelKey(labelNames, labels);
        let h = fam.values.get(key);
        if (!h) {
          h = { labels, counts: new Array(fam.buckets.length).fill(0), sum: 0, count: 0 };
          fam.values.set(key, h);
        }
        h.count += 1;
        h.sum += value;
        for (let i = 0; i < fam.buckets.length; i++) {
          if (value <= fam.buckets[i]!) h.counts[i]! += 1;
        }
      },
    };
  }

  /** Render all families in Prometheus text exposition format. */
  render(): string {
    if (this.families.size === 0) return "";
    const lines: string[] = [];
    for (const fam of this.families.values()) {
      lines.push(`# HELP ${fam.name} ${fam.help}`);
      lines.push(`# TYPE ${fam.name} ${fam.type}`);
      if (fam.type === "histogram") {
        for (const h of fam.values.values()) {
          const pairs = this.labelPairs(fam.labelNames, h.labels);
          for (let i = 0; i < fam.buckets.length; i++) {
            const le = escapeLabel(String(fam.buckets[i]));
            lines.push(`${fam.name}_bucket${formatPairs([...pairs, ["le", le]])} ${h.counts[i]}`);
          }
          lines.push(`${fam.name}_bucket${formatPairs([...pairs, ["le", "+Inf"]])} ${h.count}`);
          lines.push(`${fam.name}_sum${formatPairs(pairs)} ${h.sum}`);
          lines.push(`${fam.name}_count${formatPairs(pairs)} ${h.count}`);
        }
      } else {
        for (const v of fam.values.values()) {
          lines.push(`${fam.name}${formatPairs(this.labelPairs(fam.labelNames, v.labels))} ${v.value}`);
        }
      }
    }
    return lines.join("\n") + "\n";
  }

  /** Test-only: clear all families. */
  reset(): void {
    this.families.clear();
  }
}

/**
 * Process-wide singleton used by the appserver. Each sample names the replica
 * it came from, so a two-replica service exposes two series per metric instead
 * of one series that flaps between them.
 */
const replicaId = process.env.RAILWAY_REPLICA_ID;
export const metrics = new Metrics(replicaId ? { replica: replicaId } : {});
