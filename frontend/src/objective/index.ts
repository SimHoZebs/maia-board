// Grader role, wired to its bot-2400 implementation. Everything downstream
// (grades, bar, graphs) imports the role from here and never names a model.
// Candidate-display math (winrate columns) lives in ./winrate and is not
// part of the role: InsightPanel imports it directly.
export * from './grader';
export * from './winrate';
