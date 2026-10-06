// Test preload for the mutation gate script: every @stryker-mutator/* import gets a
// stub whose runMutationTest prints the options Stryker would run with and exits 0.
// Read at run time, so an override after `new Stryker(...)` is seen too.
import { registerHooks } from "node:module";

const stub = `export class Stryker {
  constructor(options) { this.options = options; }
  runMutationTest() { console.log(JSON.stringify(this.options)); process.exit(0); }
}`;
registerHooks({
  resolve: (specifier, context, next) =>
    specifier.startsWith("@stryker-mutator/")
      ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
      : next(specifier, context),
});
