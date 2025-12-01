import { Deferred } from "./deferred";

type StateKey = string & { __brand: "stateKey" };

interface RawState {
  key: string;
  data: unknown;
  next: string[] | null;
}

interface State<T> {
  key: StateKey;
  data: T;
  next: string[] | null;
}

function state<T>(key: string, data: T, next?: RawState[]): State<T> {
  const nextKeys = next?.map((next) => next.key);
  return { key: key as StateKey, data, next: nextKeys || null };
}

const state1 = state("state1", { count: 0 });
const state2 = state("state2", { count: 1 }, [state1]);

export class AsyncStateMachine<T, K extends StateKey> {
  #states: Map<K, State<T, K>> = new Map();
  #currentStateKey: K | null = null;
  #stateDeferred: Deferred<void> = new Deferred();

  addState(state: State<T, K>): void {
    this.#states.set(state.key as K, state);
    if (this.#currentStateKey === null) {
      this.#currentStateKey = state.key as K;
      this.#stateDeferred.resolve();
    }
  }

  async getCurrentState(): Promise<State<T, K>> {
    while (this.#currentStateKey === null) {
      await this.#stateDeferred.promise;
    }
    const state = this.#states.get(this.#currentStateKey);
    if (!state) {
      throw new Error("Current state not found");
    }
    return state;
  }

  async moveToNextState(): Promise<void> {
    const currentState = await this.getCurrentState();
    if (currentState.next === null) {
      throw new Error("No next state to move to");
    }
    const nextState = this.#states.get(currentState.next);
    if (!nextState) {
      throw new Error("Next state not found");
    }
    this.#currentStateKey = nextState.key as K;
  }
}

// Example usage
const asm = new AsyncStateMachine<{ count: number }, StateKey>();
asm.addState(testState);
asm.addState(testState2);

(async () => {
  let state = await asm.getCurrentState();
  console.log(state.data); // { count: 0 }
  await asm.moveToNextState();
  state = await asm.getCurrentState();
  console.log(state.data); // { count: 1 }
})();
