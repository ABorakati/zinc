// The website's live demo of the sidebar: the real sidebar code on the in-memory mock host, with a library of well-known public
// papers and a pretend document that the parent page draws (website/src/pages/demo.astro). Imported by demo.ts before main.ts, so
// main() picks up this host (globalThis.__znHost). Citations go where the parent page put the caret (setCursor), as in Word.
import type { ZoteroItemData } from "../../../core/src/api-types";
import { createMockHost } from "./mockhost";

const a = (...names: string[]) =>
	names.map((n) => {
		const [lastName, firstName] = n.split(", ");
		return { creatorType: "author", lastName, firstName };
	});
const item = (key: string, d: Record<string, unknown>) => ({ key, ...d }) as unknown as ZoteroItemData;

export const DEMO_ITEMS: ZoteroItemData[] = [
	item("DEMOAIAN", {
		itemType: "conferencePaper",
		title: "Attention Is All You Need",
		creators: a(
			"Vaswani, Ashish",
			"Shazeer, Noam",
			"Parmar, Niki",
			"Uszkoreit, Jakob",
			"Jones, Llion",
			"Gomez, Aidan N.",
			"Kaiser, Łukasz",
			"Polosukhin, Illia",
		),
		date: "2017",
		proceedingsTitle: "Advances in Neural Information Processing Systems",
		volume: "30",
		pages: "5998-6008",
	}),
	item("DEMORESN", {
		itemType: "conferencePaper",
		title: "Deep Residual Learning for Image Recognition",
		creators: a("He, Kaiming", "Zhang, Xiangyu", "Ren, Shaoqing", "Sun, Jian"),
		date: "2016",
		proceedingsTitle: "Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition",
		pages: "770-778",
		DOI: "10.1109/CVPR.2016.90",
	}),
	item("DEMODEEP", {
		itemType: "journalArticle",
		title: "Deep learning",
		creators: a("LeCun, Yann", "Bengio, Yoshua", "Hinton, Geoffrey"),
		date: "2015",
		publicationTitle: "Nature",
		volume: "521",
		issue: "7553",
		pages: "436-444",
		DOI: "10.1038/nature14539",
	}),
	item("DEMODERM", {
		itemType: "journalArticle",
		title: "Dermatologist-level classification of skin cancer with deep neural networks",
		creators: a(
			"Esteva, Andre",
			"Kuprel, Brett",
			"Novoa, Roberto A.",
			"Ko, Justin",
			"Swetter, Susan M.",
			"Blau, Helen M.",
			"Thrun, Sebastian",
		),
		date: "2017",
		publicationTitle: "Nature",
		volume: "542",
		issue: "7639",
		pages: "115-118",
		DOI: "10.1038/nature21056",
	}),
	item("DEMORETI", {
		itemType: "journalArticle",
		title: "Development and Validation of a Deep Learning Algorithm for Detection of Diabetic Retinopathy in Retinal Fundus Photographs",
		creators: a("Gulshan, Varun", "Peng, Lily", "Coram, Marc"),
		date: "2016",
		publicationTitle: "JAMA",
		volume: "316",
		issue: "22",
		pages: "2402-2410",
		DOI: "10.1001/jama.2016.17216",
	}),
	item("DEMOSHAP", {
		itemType: "conferencePaper",
		title: "A Unified Approach to Interpreting Model Predictions",
		creators: a("Lundberg, Scott M.", "Lee, Su-In"),
		date: "2017",
		proceedingsTitle: "Advances in Neural Information Processing Systems",
		volume: "30",
	}),
	item("DEMOUNET", {
		itemType: "conferencePaper",
		title: "U-Net: Convolutional Networks for Biomedical Image Segmentation",
		creators: a("Ronneberger, Olaf", "Fischer, Philipp", "Brox, Thomas"),
		date: "2015",
		proceedingsTitle: "Medical Image Computing and Computer-Assisted Intervention",
		pages: "234-241",
		DOI: "10.1007/978-3-319-24574-4_28",
	}),
	item("DEMOCONS", {
		itemType: "journalArticle",
		title: "CONSORT 2010 Statement: updated guidelines for reporting parallel group randomised trials",
		creators: a("Schulz, Kenneth F.", "Altman, Douglas G.", "Moher, David"),
		date: "2010",
		publicationTitle: "BMJ",
		volume: "340",
		pages: "c332",
		DOI: "10.1136/bmj.c332",
	}),
	item("DEMOPRIS", {
		itemType: "journalArticle",
		title: "Preferred Reporting Items for Systematic Reviews and Meta-Analyses: The PRISMA Statement",
		creators: a("Moher, David", "Liberati, Alessandro", "Tetzlaff, Jennifer", "Altman, Douglas G."),
		date: "2009",
		publicationTitle: "PLoS Medicine",
		volume: "6",
		issue: "7",
		pages: "e1000097",
		DOI: "10.1371/journal.pmed.1000097",
	}),
	item("DEMOIMGN", {
		itemType: "conferencePaper",
		title: "ImageNet Classification with Deep Convolutional Neural Networks",
		creators: a("Krizhevsky, Alex", "Sutskever, Ilya", "Hinton, Geoffrey E."),
		date: "2012",
		proceedingsTitle: "Advances in Neural Information Processing Systems",
		volume: "25",
		pages: "1097-1105",
	}),
	item("DEMOTOPL", {
		itemType: "journalArticle",
		title: "High-performance medicine: the convergence of human and artificial intelligence",
		creators: a("Topol, Eric J."),
		date: "2019",
		publicationTitle: "Nature Medicine",
		volume: "25",
		issue: "1",
		pages: "44-56",
		DOI: "10.1038/s41591-018-0300-7",
	}),
	item("DEMOTRIP", {
		itemType: "journalArticle",
		title: "Transparent Reporting of a multivariable prediction model for Individual Prognosis or Diagnosis (TRIPOD): The TRIPOD Statement",
		creators: a("Collins, Gary S.", "Reitsma, Johannes B.", "Altman, Douglas G.", "Moons, Karel G. M."),
		date: "2015",
		publicationTitle: "Annals of Internal Medicine",
		volume: "162",
		issue: "1",
		pages: "55-63",
		DOI: "10.7326/M14-0697",
	}),
];

export const DEMO_BODY =
	"Deep learning has changed how medical images are read. Convolutional networks now match specialists at grading diabetic retinopathy and at classifying skin lesions, and transformer models have since reshaped language tasks. Reporting standards still apply: trials of these tools should follow CONSORT, and prediction models should follow TRIPOD.";

const host = createMockHost({
	items: DEMO_ITEMS,
	body: DEMO_BODY,
	styleXml: (id) => fetch(`styles/${id}.csl`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`style ${id}: HTTP ${r.status}`)))),
	localeXml: (lang) =>
		fetch(`locales/locales-${lang}.xml`)
			.then((r) => (r.ok ? r.text() : null))
			.catch(() => null),
});

// the caret in the pretend document: the end of the first sentence until the visitor clicks elsewhere
let cursor = DEMO_BODY.indexOf(". Convolutional");
const call = host.call.bind(host);
host.call = async (method: string, params: Record<string, unknown> = {}) => {
	// a citation inserted "at the cursor" goes to the caret; a bibliography goes at the end, as in Word
	const p =
		method === "doc.insert" && params.kind === "item" && !params.at && !params.after ? { ...params, at: { pos: cursor } } : params;
	const r = await call(method, p);
	if (/^doc\.(insert|set|delete|unlink|convert)$/.test(method)) dispatchEvent(new Event("zn-demo-change"));
	return r;
};

const demo = {
	host,
	body: DEMO_BODY,
	get cursor() {
		return cursor;
	},
	setCursor(pos: number) {
		cursor = Math.max(0, Math.min(DEMO_BODY.length, pos));
	},
	/** put the sidebar's cursor in a citation, as Word's cursor watcher does when the caret enters a field */
	enterField(i: number) {
		const f = host.fields[i];
		if (!f) return;
		host.emit("cursor", {
			hasDoc: true,
			doc: "Preview.docx",
			start: 1,
			end: 1,
			story: 1,
			inField: true,
			ref: { story: f.story, idx: f.idx },
			kind: f.kind,
			code: f.code,
			text: f.text,
		});
	},
	leaveField() {
		host.emit("cursor", { hasDoc: true, doc: "Preview.docx", start: 1, end: 1, story: 1, inField: false });
	},
};
(globalThis as Record<string, unknown>).__znHost = host;
(globalThis as Record<string, unknown>).__znDemo = demo;
