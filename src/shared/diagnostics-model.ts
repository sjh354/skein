/**
 * Structure diagnostics (DESIGN 7): the five areas, each result kept as a confirmed
 * violation of a declared rule or a review candidate. Candidates are never marked as
 * confirmed: meaning needs a reader, the analysis only offers the evidence.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic.
 */

export const DIAGNOSTIC_KINDS = [
  "responsibility",
  "duplication",
  "placement",
  "abstraction",
  "dependency",
] as const;

export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];

/** `confirmed` needs a declared rule; everything else is a candidate for review. */
export type DiagnosticStatus = "confirmed" | "candidate";

/** How the current result relates to the recorded baseline. */
export type DiagnosticBaselineState = "new" | "accepted" | "worsened" | "excepted";

export interface DiagnosticLocation {
  path: string;
  line?: number;
  symbol?: string;
}

export interface DiagnosticEvidence {
  label: string;
  value: string | number;
}

export interface StructureDiagnostic {
  /** Stable across line moves: kind, locations and rule, never a line number. */
  id: string;
  kind: DiagnosticKind;
  status: DiagnosticStatus;
  title: string;
  area?: string;
  rule?: string;
  locations: DiagnosticLocation[];
  evidence: DiagnosticEvidence[];
  /** What this analysis cannot decide, stated with the result. */
  limits: string[];
  metrics: Record<string, number>;
  baseline: DiagnosticBaselineState;
  /** Compared with the baseline value to decide `worsened`. */
  value: number;
}

export interface DiagnosticKindTotals {
  confirmed: number;
  candidate: number;
  new: number;
  worsened: number;
  excepted: number;
}

export interface DiagnosticThresholds {
  responsibility: { loc: number; fanOut: number; fanIn: number };
  duplication: { minTokens: number; shingleSize: number; similarity: number; maxResults: number };
  dependency: { heavyPairs: number; maxResults: number };
}

export interface DiagnosticArea {
  name: string;
  path: string[];
  profile: string;
  strict: boolean;
}

export interface StructureDiagnosticsResult {
  revision: string;
  thresholds: DiagnosticThresholds;
  areas: DiagnosticArea[];
  profiles: Record<string, { layers: string[][] }>;
  exceptions: number;
  diagnostics: StructureDiagnostic[];
  totals: Record<DiagnosticKind, DiagnosticKindTotals> & DiagnosticKindTotals;
  /** Baseline entries no longer reported. */
  resolved: { id: string; value: number }[];
  limits: string[];
}

/** The five areas, in the order the docs and the view show them. */
export const DIAGNOSTIC_KIND_LABELS: Record<DiagnosticKind, string> = {
  responsibility: "Responsibility concentration",
  duplication: "Duplicated implementation",
  placement: "Feature placement",
  abstraction: "Over-abstraction",
  dependency: "Dependency problems",
};

export const DEFAULT_DIAGNOSTIC_THRESHOLDS: DiagnosticThresholds = {
  responsibility: { loc: 400, fanOut: 15, fanIn: 30 },
  duplication: { minTokens: 40, shingleSize: 20, similarity: 0.85, maxResults: 200 },
  dependency: { heavyPairs: 10, maxResults: 200 },
};
