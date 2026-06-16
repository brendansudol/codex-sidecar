export interface TemplateDef {
    description?: string;
    defaultQuestion?: string;
    body: string;
}
export interface ParsedTemplate {
    description?: string;
    defaultQuestion?: string;
    body: string;
}
/**
 * Substitute {{var}} placeholders from `vars`. Any placeholder that is not a known, well-formed
 * variable is a hard error (surfaced in the foreground before the worker spawns), never silently
 * passed through.
 */
export declare function renderTemplate(body: string, vars: Record<string, string>): string;
/**
 * Parse a template file into frontmatter + body.
 *
 * Frontmatter grammar (intentionally minimal, not YAML):
 * - opening `---` on the first line
 * - closing `---` on its own line
 * - `key: value` pairs in between, single-line values, known keys only
 * If the first line is not `---`, or there is no closing fence, the whole file is the body.
 */
export declare function parseTemplateFile(text: string): ParsedTemplate;
export declare const BUILTIN_TEMPLATES: Record<string, TemplateDef>;
export declare const DEFAULT_TEMPLATE = "review";
