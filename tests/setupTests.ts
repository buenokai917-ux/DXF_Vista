// Basic notifier fallback for environments without a browser alert.
if (typeof globalThis.alert !== "function") {
  globalThis.alert = (message?: string) => {
    if (message) console.log(message);
  };
}
