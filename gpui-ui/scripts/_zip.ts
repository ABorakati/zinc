// The PowerShell command that zips a package folder on Windows (package.ts --zip).

/** The text as a PowerShell single-quoted string: a quote inside it is doubled. */
export const psQuote = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

// -LiteralPath: a folder name with [ ] in it is a name, not a wildcard
export function compressCommand(app: string, zip: string): string {
	return `Compress-Archive -LiteralPath ${psQuote(app)} -DestinationPath ${psQuote(zip)} -CompressionLevel Optimal`;
}
