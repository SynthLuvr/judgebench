const errorCodeOf = (error: unknown): string => {
  // node fs errors and commander errors both carry a string `code`.
  if (typeof error === "object" && error !== null && "code" in error) {
    const code: unknown = error.code;
    if (typeof code === "string") return code;
  }
  return "";
};

export { errorCodeOf };
