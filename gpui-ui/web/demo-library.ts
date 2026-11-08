// The browser demo's library: well-known public papers (metadata only), collections with colours, icons, pins and sections, coloured
// tags and a note, like the README screenshots. Writes <out>/library.sqlite and <out>/collection-style.json (the sidebar's styles).
//   bun web/demo-library.ts <out dir>          (from gpui-ui/; never points at a real library)
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as repo from "../../core/src/db";
import { rebuildSearchIndex } from "../../core/src/search";

const out = resolve(process.argv[2] ?? "out/demo-library");
if (/zotero-next[\\/]data$/i.test(out)) throw new Error("refusing to write into the real data folder");
mkdirSync(out, { recursive: true });
const file = join(out, "library.sqlite");
for (const s of ["", "-wal", "-shm"]) if (existsSync(file + s)) rmSync(file + s);

const a = (...names: string[]) => names.map((n) => { const [lastName, firstName] = n.split(", "); return { creatorType: "author", lastName, firstName }; });
type Paper = Record<string, unknown> & { id: string; tags?: string[]; in?: string[] };
const papers: Paper[] = [
	{ id: "attention", itemType: "conferencePaper", title: "Attention Is All You Need", creators: a("Vaswani, Ashish", "Shazeer, Noam", "Parmar, Niki", "Uszkoreit, Jakob", "Jones, Llion", "Gomez, Aidan N.", "Kaiser, Łukasz", "Polosukhin, Illia"), date: "2017", proceedingsTitle: "Advances in Neural Information Processing Systems", volume: "30", pages: "5998-6008", url: "https://papers.nips.cc/paper/7181-attention-is-all-you-need", tags: ["seminal", "transformers"], in: ["thesis", "lm", "toread"] },
	{ id: "shap", itemType: "conferencePaper", title: "A Unified Approach to Interpreting Model Predictions", creators: a("Lundberg, Scott M.", "Lee, Su-In"), date: "2017", proceedingsTitle: "Advances in Neural Information Processing Systems", volume: "30", url: "https://papers.nips.cc/paper/7062-a-unified-approach-to-interpreting-model-predictions", tags: ["interpretability"], in: ["methods", "thesis"] },
	{ id: "derm", itemType: "journalArticle", title: "Dermatologist-level classification of skin cancer with deep neural networks", creators: a("Esteva, Andre", "Kuprel, Brett", "Novoa, Roberto A.", "Ko, Justin", "Swetter, Susan M.", "Blau, Helen M.", "Thrun, Sebastian"), date: "2017", publicationTitle: "Nature", volume: "542", issue: "7639", pages: "115-118", DOI: "10.1038/nature21056", tags: ["medical imaging"], in: ["cv", "thesis", "reading"] },
	{ id: "resnet", itemType: "conferencePaper", title: "Deep Residual Learning for Image Recognition", creators: a("He, Kaiming", "Zhang, Xiangyu", "Ren, Shaoqing", "Sun, Jian"), date: "2016", proceedingsTitle: "Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition", pages: "770-778", DOI: "10.1109/CVPR.2016.90", tags: ["seminal", "convolutional networks"], in: ["cv", "dl"] },
	{ id: "retina", itemType: "journalArticle", title: "Development and Validation of a Deep Learning Algorithm for Detection of Diabetic Retinopathy in Retinal Fundus Photographs", creators: a("Gulshan, Varun", "Peng, Lily", "Coram, Marc"), date: "2016", publicationTitle: "JAMA", volume: "316", issue: "22", pages: "2402-2410", DOI: "10.1001/jama.2016.17216", tags: ["medical imaging"], in: ["cv", "thesis", "clinical", "reading"] },
	{ id: "deep", itemType: "journalArticle", title: "Deep learning", creators: a("LeCun, Yann", "Bengio, Yoshua", "Hinton, Geoffrey"), date: "2015", publicationTitle: "Nature", volume: "521", issue: "7553", pages: "436-444", DOI: "10.1038/nature14539", tags: ["seminal"], in: ["dl", "foundations"] },
	{ id: "adam", itemType: "conferencePaper", title: "Adam: A Method for Stochastic Optimization", creators: a("Kingma, Diederik P.", "Ba, Jimmy"), date: "2015", proceedingsTitle: "International Conference on Learning Representations", url: "https://arxiv.org/abs/1412.6980", in: ["dl", "methods"] },
	{ id: "unet", itemType: "conferencePaper", title: "U-Net: Convolutional Networks for Biomedical Image Segmentation", creators: a("Ronneberger, Olaf", "Fischer, Philipp", "Brox, Thomas"), date: "2015", proceedingsTitle: "Medical Image Computing and Computer-Assisted Intervention", pages: "234-241", DOI: "10.1007/978-3-319-24574-4_28", tags: ["medical imaging", "convolutional networks"], in: ["cv", "thesis"] },
	{ id: "tripod", itemType: "journalArticle", title: "Transparent Reporting of a multivariable prediction model for Individual Prognosis or Diagnosis (TRIPOD): The TRIPOD Statement", creators: a("Collins, Gary S.", "Reitsma, Johannes B.", "Altman, Douglas G.", "Moons, Karel G. M."), date: "2015", publicationTitle: "Annals of Internal Medicine", volume: "162", issue: "1", pages: "55-63", DOI: "10.7326/M14-0697", tags: ["reporting"], in: ["clinical", "methods"] },
	{ id: "imagenet", itemType: "conferencePaper", title: "ImageNet Classification with Deep Convolutional Neural Networks", creators: a("Krizhevsky, Alex", "Sutskever, Ilya", "Hinton, Geoffrey E."), date: "2012", proceedingsTitle: "Advances in Neural Information Processing Systems", volume: "25", pages: "1097-1105", tags: ["seminal", "convolutional networks"], in: ["cv", "foundations"] },
	{ id: "consort", itemType: "journalArticle", title: "CONSORT 2010 Statement: updated guidelines for reporting parallel group randomised trials", creators: a("Schulz, Kenneth F.", "Altman, Douglas G.", "Moher, David"), date: "2010", publicationTitle: "BMJ", volume: "340", pages: "c332", DOI: "10.1136/bmj.c332", tags: ["reporting"], in: ["clinical"] },
	{ id: "prisma", itemType: "journalArticle", title: "Preferred Reporting Items for Systematic Reviews and Meta-Analyses: The PRISMA Statement", creators: a("Moher, David", "Liberati, Alessandro", "Tetzlaff, Jennifer", "Altman, Douglas G."), date: "2009", publicationTitle: "PLoS Medicine", volume: "6", issue: "7", pages: "e1000097", DOI: "10.1371/journal.pmed.1000097", tags: ["reporting"], in: ["clinical", "methods"] },
	{ id: "topol", itemType: "journalArticle", title: "High-performance medicine: the convergence of human and artificial intelligence", creators: a("Topol, Eric J."), date: "2019", publicationTitle: "Nature Medicine", volume: "25", issue: "1", pages: "44-56", DOI: "10.1038/s41591-018-0300-7", in: ["clinical", "toread", "reading"] },
	{ id: "bert", itemType: "conferencePaper", title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding", creators: a("Devlin, Jacob", "Chang, Ming-Wei", "Lee, Kenton", "Toutanova, Kristina"), date: "2019", proceedingsTitle: "Proceedings of NAACL-HLT", pages: "4171-4186", DOI: "10.18653/v1/N19-1423", tags: ["transformers"], in: ["lm", "toread"] },
	{ id: "gpt3", itemType: "conferencePaper", title: "Language Models are Few-Shot Learners", creators: a("Brown, Tom B.", "Mann, Benjamin", "Ryder, Nick", "Subbiah, Melanie"), date: "2020", proceedingsTitle: "Advances in Neural Information Processing Systems", volume: "33", pages: "1877-1901", tags: ["transformers"], in: ["lm"] },
	{ id: "dropout", itemType: "journalArticle", title: "Dropout: A Simple Way to Prevent Neural Networks from Overfitting", creators: a("Srivastava, Nitish", "Hinton, Geoffrey", "Krizhevsky, Alex", "Sutskever, Ilya", "Salakhutdinov, Ruslan"), date: "2014", publicationTitle: "Journal of Machine Learning Research", volume: "15", issue: "56", pages: "1929-1958", in: ["dl", "methods"] },
	{ id: "boot", itemType: "book", title: "An Introduction to the Bootstrap", creators: a("Efron, Bradley", "Tibshirani, Robert J."), date: "1994", publisher: "Chapman & Hall/CRC", place: "New York", ISBN: "9780412042317", in: ["stats", "foundations"] },
	{ id: "elements", itemType: "book", title: "The Elements of Statistical Learning", creators: a("Hastie, Trevor", "Tibshirani, Robert", "Friedman, Jerome"), date: "2009", edition: "2", publisher: "Springer", place: "New York", ISBN: "9780387848570", in: ["stats", "foundations"] },
];

const db = repo.openDb(file);
const col = (name: string, parent?: string) => repo.createCollection(db, name, parent ?? null).key;
const C = {
	thesis: col("Thesis"), toread: col("To read"), reading: col("Reading group"),
	clinical: col("Clinical and reporting"), cv: col("Computer vision"), dl: col("Deep learning"), foundations: col("Foundations"),
	lm: col("Language models"), methods: col("Methods"), stats: col("Statistics"),
};
const keys: Record<string, string> = {};
for (const p of papers) {
	const { id, tags, in: cols, ...data } = p;
	const key = repo.createItem(db, data as never).data.key;
	keys[id] = key;
	if (tags?.length) repo.addTags(db, key, tags);
	for (const c of cols ?? []) repo.addItemsToCollection(db, C[c as keyof typeof C], [key]);
}
repo.createItem(db, { itemType: "note", parentItem: keys.attention, note: "<p>Core claim: attention alone is enough. Compare with the BLEU table in section 6.</p>" } as never);
repo.setTagColors(db, [
	{ name: "seminal", color: "#FF6666" }, { name: "transformers", color: "#2EA8E5" },
	{ name: "medical imaging", color: "#A28AE5" }, { name: "convolutional networks", color: "#5FB236" },
]);
rebuildSearchIndex(db);
db.exec("PRAGMA journal_mode=DELETE; VACUUM;");
db.close();

const style = (color: string, icon: string, section?: string) => ({ color, icon, ...(section ? { section } : {}) });
writeFileSync(join(out, "collection-style.json"), JSON.stringify({
	sort: "name-asc", group: "section", sections: ["Projects", "Topics"], collapsed: [], pins: [C.thesis, C.toread],
	styles: {
		[C.thesis]: style("blue", "graduation-cap", "Projects"), [C.toread]: style("rust", "inbox", "Projects"), [C.reading]: style("green", "users", "Projects"),
		[C.clinical]: style("rose", "file-text", "Topics"), [C.cv]: style("sky", "microscope", "Topics"), [C.dl]: style("amber", "layers", "Topics"),
		[C.foundations]: style("blue", "book-open", "Topics"), [C.lm]: style("violet", "brain", "Topics"), [C.methods]: style("green", "flask-conical", "Topics"),
		[C.stats]: style("slate", "target", "Topics"),
	},
	stamps: {}, stampsSeeded: false,
}, null, 2));
console.log(`demo library -> ${file} (${papers.length} items, ${Object.keys(C).length} collections)`);
