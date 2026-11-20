// Office.js globals, loosely typed: the add-in loads office.js from Microsoft's CDN at run time and the repository has no
// @types/office-js (no new dependencies). Narrow types live next to the code that uses them.
declare const Office: any;
declare const Word: any;
declare const OfficeExtension: any;
declare namespace Word {
	type RequestContext = any;
	type Field = any;
	type FieldCollection = any;
	type Range = any;
	type ContentControl = any;
	type ContentControlCollection = any;
	type Body = any;
	type Paragraph = any;
	type Note = any;
	type TrackedChange = any;
}
