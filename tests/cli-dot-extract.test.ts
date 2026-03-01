import test from "node:test";
import assert from "node:assert/strict";

import { parseDot } from "../src/attractor/parser.ts";
import {
  buildFallbackDot,
  deriveCliRunStatus,
  extractDot,
  hasExpectedDevPipelineContract,
  hasExpectedTestRouting,
} from "../src/cli/dev.ts";

test("extractDot ignores non-dot fenced blocks and returns a complete digraph block", () => {
  const modelText = [
    "Here is analysis:",
    "```text",
    "Use digraph syntax and ensure one start node.",
    "```",
    "```dot",
    'digraph "openoxen-dev" {',
    "  start [shape=Mdiamond]",
    "  done [shape=Msquare]",
    "  start -> done",
    "}",
    "```",
  ].join("\n");

  const dot = extractDot(modelText);
  assert.equal(typeof dot, "string");
  const graph = parseDot(dot!);
  assert.equal(graph.nodes.has("start"), true);
  assert.equal(graph.nodes.has("done"), true);
});

test("extractDot supports strict digraph in plain text", () => {
  const modelText = [
    "strict digraph pipeline {",
    "  start [shape=Mdiamond]",
    "  done [shape=Msquare]",
    "  start -> done",
    "}",
    "Additional prose that should be ignored.",
  ].join("\n");

  const dot = extractDot(modelText);
  assert.equal(typeof dot, "string");
  const graph = parseDot(dot!);
  assert.equal(graph.edges.length, 1);
});

test("hasExpectedTestRouting rejects test edges without explicit outcome conditions", () => {
  const graph = parseDot(`
  digraph G {
    start [shape=Mdiamond]
    test [shape=parallelogram, tool_command="npm test"]
    done [shape=Msquare]
    start -> test
    test -> done [label="success"]
  }
  `);
  assert.equal(hasExpectedTestRouting(graph), false);
});

test("hasExpectedTestRouting accepts explicit success/fail conditions", () => {
  const graph = parseDot(`
  digraph G {
    start [shape=Mdiamond]
    test [shape=parallelogram, tool_command="npm test"]
    done [shape=Msquare]
    retry [shape=box]
    start -> test
    test -> done [condition="outcome=success"]
    test -> retry [condition="outcome=fail"]
  }
  `);
  assert.equal(hasExpectedTestRouting(graph), true);
});

test("deriveCliRunStatus returns fail when a test node failed", () => {
  const status = deriveCliRunStatus({
    status: "success",
    completedNodes: ["test_1", "done"],
    nodeOutcomes: {
      test_1: { status: "fail" },
    },
    context: {},
    logsRoot: "/tmp/x",
  });
  assert.equal(status, "fail");
});

test("buildFallbackDot emits dynamic test command placeholder with default_test_command", () => {
  const dot = buildFallbackDot("实现一个网页版贪吃蛇小游戏", "npm test");
  assert.equal(dot.includes('default_test_command="npm test"'), true);
  assert.equal(dot.includes('tool_command="$test_command"'), true);
});

test("hasExpectedDevPipelineContract rejects review->develop loop edges", () => {
  const graph = parseDot(`
  digraph openoxen_dev {
    start [shape=Mdiamond]
    write_tests [shape=box]
    develop_1 [shape=box]
    review_1 [shape=box]
    test_1 [shape=parallelogram, tool_command="$test_command"]
    human_intervention [shape=hexagon]
    abort [shape=parallelogram, tool_command="exit 1"]
    done [shape=Msquare]

    start -> write_tests -> develop_1
    develop_1 -> review_1
    review_1 -> develop_1
    review_1 -> test_1 [condition="outcome=success"]
    test_1 -> done [condition="outcome=success"]
    test_1 -> human_intervention [condition="outcome=fail"]
    human_intervention -> develop_1 [label="[C] Continue"]
    human_intervention -> abort [label="[S] Stop"]
  }
  `);
  assert.equal(hasExpectedDevPipelineContract(graph), false);
});

test("hasExpectedDevPipelineContract accepts fallback template flow", () => {
  const graph = parseDot(buildFallbackDot("实现用户登录", "npm test"));
  assert.equal(hasExpectedDevPipelineContract(graph), true);
});
