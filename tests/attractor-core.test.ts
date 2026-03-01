import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDot } from '../src/attractor/parser.ts';
import { validate, validateOrRaise } from '../src/attractor/validator.ts';
import { evaluateCondition } from '../src/attractor/condition.ts';

test('parseDot parses graph attrs, nodes, edges, and chained edges', () => {
  const dot = `
  digraph demo {
    graph [goal="Ship feature", label="Pipeline"]
    node [shape=box, max_retries=2]

    start [shape=Mdiamond]
    plan  [prompt="Plan for: $goal"]
    review [shape=diamond]
    done [shape=Msquare]

    start -> plan -> review [label="Next"]
    review -> done [condition="outcome=success", weight=10]
  }
  `;

  const graph = parseDot(dot);
  assert.equal(graph.attrs.goal, 'Ship feature');
  assert.equal(graph.attrs.label, 'Pipeline');
  assert.equal(graph.nodes.size, 4);
  assert.equal(graph.edges.length, 3);
  assert.equal(graph.nodes.get('plan')?.attrs.shape, 'box');
  assert.equal(graph.nodes.get('plan')?.attrs.max_retries, 2);
  assert.equal(graph.edges[0]?.attrs.label, 'Next');
  assert.equal(graph.edges[2]?.attrs.condition, 'outcome=success');
});

test('parseDot flattens subgraphs and supports multiline attributes', () => {
  const dot = `
  digraph G {
    subgraph cluster_loop {
      node [thread_id="loop-a"]
      start [shape=Mdiamond]
      implement [
        prompt="Write code",
        class="fast"
      ]
      done [shape=Msquare]
      start -> implement -> done
    }
  }
  `;

  const graph = parseDot(dot);
  assert.equal(graph.nodes.has('implement'), true);
  assert.equal(graph.nodes.get('implement')?.attrs.thread_id, 'loop-a');
  assert.equal(graph.edges.length, 2);
});

test('parseDot supports quoted digraph identifiers', () => {
  const dot = `
  digraph "openoxen-dev" {
    start [shape=Mdiamond]
    done [shape=Msquare]
    start -> done
  }
  `;

  const graph = parseDot(dot);
  assert.equal(graph.nodes.has('start'), true);
  assert.equal(graph.nodes.has('done'), true);
  assert.equal(graph.edges.length, 1);
});

test('validate catches structural errors', () => {
  const dot = `
  digraph bad {
    a [shape=box]
    b [shape=box]
    a -> b [condition="outcome=success &&"]
  }
  `;

  const graph = parseDot(dot);
  const diags = validate(graph);
  const rules = new Set(diags.map((d) => d.rule));

  assert.equal(rules.has('start_node'), true);
  assert.equal(rules.has('terminal_node'), true);
  assert.equal(rules.has('condition_syntax'), true);
  assert.throws(() => validateOrRaise(graph));
});

test('evaluateCondition supports outcome, preferred_label, and context keys', () => {
  const outcome = { status: 'success', preferred_label: 'Ship' };
  const context = new Map<string, unknown>([
    ['tests_passed', true],
    ['context.loop_state', 'active'],
  ]);

  assert.equal(evaluateCondition('outcome=success', outcome, context), true);
  assert.equal(evaluateCondition('preferred_label=Ship', outcome, context), true);
  assert.equal(
    evaluateCondition('outcome=success && context.tests_passed=true', outcome, context),
    true,
  );
  assert.equal(evaluateCondition('context.loop_state!=exhausted', outcome, context), true);
  assert.equal(evaluateCondition('', outcome, context), true);
});
