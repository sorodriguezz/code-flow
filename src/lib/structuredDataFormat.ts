export type StructuredDataFormat = "csv" | "json" | "xml" | "yaml";

export function structuredDataFormat(path: string): StructuredDataFormat | null {
  const extension = path.match(/\.(csv|json|xml|ya?ml)$/i)?.[1]?.toLowerCase();
  switch (extension) {
    case "csv":
    case "json":
    case "xml":
      return extension;
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return null;
  }
}
