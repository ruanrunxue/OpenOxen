import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export type QuestionType = "SINGLE_SELECT" | "MULTI_SELECT" | "FREE_TEXT" | "CONFIRM";

export interface Option {
  key: string;
  label: string;
}

export interface Question {
  text: string;
  type: QuestionType;
  options?: Option[];
  stage?: string;
  timeout_seconds?: number;
}

export interface Answer {
  value: string;
  selected_option?: Option;
  text?: string;
}

export interface Interviewer {
  ask(question: Question): Promise<Answer> | Answer;
  askMultiple?(questions: Question[]): Promise<Answer[]> | Answer[];
  inform?(message: string, stage: string): Promise<void> | void;
}

export class AutoApproveInterviewer implements Interviewer {
  ask(question: Question): Answer {
    if (question.options?.length) {
      return {
        value: question.options[0]!.key,
        selected_option: question.options[0]!,
      };
    }
    if (question.type === "CONFIRM") {
      return { value: "YES" };
    }
    return { value: "auto-approved", text: "auto-approved" };
  }
}

export class QueueInterviewer implements Interviewer {
  #answers: Answer[];

  constructor(answers: Answer[] = []) {
    this.#answers = [...answers];
  }

  ask(_question: Question): Answer {
    return this.#answers.shift() ?? { value: "SKIPPED" };
  }
}

export class CallbackInterviewer implements Interviewer {
  #callback: (question: Question) => Promise<Answer> | Answer;

  constructor(callback: (question: Question) => Promise<Answer> | Answer) {
    this.#callback = callback;
  }

  ask(question: Question): Promise<Answer> | Answer {
    return this.#callback(question);
  }
}

export class ConsoleInterviewer implements Interviewer {
  async ask(question: Question): Promise<Answer> {
    const rl = readline.createInterface({ input, output });
    try {
      output.write(`\n[?] ${question.text}\n`);
      if (question.options?.length) {
        for (const opt of question.options) {
          output.write(`  [${opt.key}] ${opt.label}\n`);
        }
        const raw = (await rl.question("Select: ")).trim();
        const selected = question.options.find((o) => o.key.toLowerCase() === raw.toLowerCase());
        if (selected) {
          return { value: selected.key, selected_option: selected };
        }
        return { value: raw || question.options[0]!.key, selected_option: question.options[0] };
      }
      const raw = (await rl.question("> ")).trim();
      return { value: raw, text: raw };
    } finally {
      rl.close();
    }
  }
}

