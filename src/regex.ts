import vm from "node:vm";

export const REGEX_TEST_TIMEOUT_MS = 50;
export const GREP_MAX_PATTERN_CHARS = 512;

export function createRegexTester(
  source: string,
  flags: string,
): (text: string) => boolean | "timeout" {
  const sandbox: {
    source: string;
    flags: string;
    text: string;
    matched: boolean;
  } = {
    source,
    flags,
    text: "",
    matched: false,
  };
  const context = vm.createContext(sandbox);
  const script = new vm.Script("matched = new RegExp(source, flags).test(text)");
  return (text: string): boolean | "timeout" => {
    sandbox.text = text;
    sandbox.matched = false;
    try {
      script.runInContext(context, { timeout: REGEX_TEST_TIMEOUT_MS });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/timed out/i.test(message)) {
        return "timeout";
      }
      throw err;
    }
    return sandbox.matched;
  };
}
