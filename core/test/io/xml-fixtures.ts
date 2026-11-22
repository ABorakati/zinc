// Deterministic EndNote XML, MODS and Zotero RDF documents of n records, with mixed content (text around <style> runs and
// other child elements). Used by xml.test.ts, and by the memory and time probes of the XML reader.

export function endnoteXml(n: number): string {
	const out = ['<?xml version="1.0" encoding="UTF-8"?><xml><records>'];
	for (let i = 0; i < n; i++) {
		out.push(`<record><database name="lib.enl" path="C:\\lib.enl">lib.enl</database><ref-type name="Journal Article">17</ref-type>
<contributors><authors><author><style face="normal" font="default" size="100%">Smith${i}, Jane</style></author><author><style face="normal" font="default" size="100%">Lee, Ann ${i}</style></author></authors></contributors>
<titles><title><style face="normal" font="default" size="100%">Cells </style><style face="italic" font="default" size="100%">and</style><style face="normal" font="default" size="100%"> tissues ${i} part </style><style face="bold">two</style></title><secondary-title><style face="normal">Journal of Cells ${i % 50}</style></secondary-title></titles>
<periodical><full-title><style face="normal">Journal of Cells</style></full-title></periodical>
<pages><style face="normal">11-19</style></pages><volume>${i % 40}</volume><number>2</number>
<keywords><keyword><style face="normal">cell${i % 9}</style></keyword><keyword><style face="normal">tissue</style></keyword></keywords>
<dates><year><style face="normal">${1990 + (i % 30)}</style></year></dates>
<abstract><style face="normal">About cells, lead-in text </style><style face="italic">emphasis</style><style face="normal"> and trailing text ${i}. ${"Lorem ipsum dolor sit amet. ".repeat(20)}</style></abstract>
<electronic-resource-num><style>10.5555/cells.${i}</style></electronic-resource-num>
<urls><related-urls><url><style>https://example.org/cells/${i}</style></url></related-urls></urls>
<notes><style face="normal">Remember this ${i}</style> and <style face="italic">more</style> afterwards</notes></record>
`);
	}
	out.push("</records></xml>");
	return out.join("");
}

export function modsXml(n: number): string {
	const out = ['<?xml version="1.0" encoding="UTF-8"?><modsCollection xmlns="http://www.loc.gov/mods/v3">'];
	for (let i = 0; i < n; i++) {
		out.push(`<mods>
<titleInfo><nonSort>The </nonSort><title>Spleen ${i}</title><subTitle>an atlas</subTitle></titleInfo>
<name type="personal"><namePart type="family">Smith${i}</namePart><namePart type="given">Jane</namePart><role><roleTerm type="code" authority="marcrelator">aut</roleTerm></role></name>
<name type="personal"><namePart type="family">Patel</namePart><namePart type="given">Dev</namePart><role><roleTerm type="code" authority="marcrelator">edt</roleTerm></role></name>
<typeOfResource>text</typeOfResource><genre authority="marcgt">article</genre>
<originInfo><dateIssued>${1990 + (i % 30)}-05</dateIssued><publisher>Elsevier</publisher><place><placeTerm type="text">London</placeTerm></place></originInfo>
<language><languageTerm type="code" authority="iso639-2b">eng</languageTerm></language><language>fre</language>
<abstract>${"Studied the spleen in detail. ".repeat(20)}</abstract>
<subject><topic>anatomy</topic></subject><subject><topic>surgery ${i % 7}</topic></subject>
<relatedItem type="host"><titleInfo><title>Textbook of Surgery</title></titleInfo><part><detail type="volume"><number>${i % 40}</number></detail><detail type="issue"><number>2</number></detail><extent unit="page"><start>45</start><end>67</end></extent></part></relatedItem>
<identifier type="doi">10.5555/spleen.${i}</identifier><identifier type="issn">1234-5678</identifier>
<note>Remember ${i}</note>
</mods>
`);
	}
	out.push("</modsCollection>");
	return out.join("");
}

export function rdfXml(n: number): string {
	const out = [
		`<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:bib="http://purl.org/net/biblio#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:prism="http://prismstandard.org/namespaces/1.2/basic/" xmlns:foaf="http://xmlns.com/foaf/0.1/" xmlns:link="http://purl.org/rss/1.0/modules/link/" xmlns:z="http://www.zotero.org/namespaces/export#">`,
	];
	for (let i = 0; i < n; i++) {
		out.push(`  <bib:Article rdf:about="#item_${i}">
    <z:itemType>journalArticle</z:itemType>
    <dcterms:isPartOf rdf:resource="urn:issn:0140-${i % 90}"/>
    <dc:title>Outcomes ${i}</dc:title>
    <bib:authors><rdf:Seq>
      <rdf:li><foaf:Person><foaf:surname>Smith${i}</foaf:surname><foaf:givenName>Jane</foaf:givenName></foaf:Person></rdf:li>
    </rdf:Seq></bib:authors>
    <dc:date>2023-11-02</dc:date>
    <dcterms:abstract>${"We studied patients. ".repeat(20)}</dcterms:abstract>
    <dc:subject>tag ${i % 20}</dc:subject>
    <dcterms:isReferencedBy rdf:resource="#item_${i}_note"/>
  </bib:Article>
  <bib:Memo rdf:about="#item_${i}_note"><rdf:value>&lt;p&gt;Note ${i}&lt;/p&gt;</rdf:value></bib:Memo>
  <bib:Journal rdf:about="urn:issn:0140-${i % 90}"><dc:title>Journal ${i % 90}</dc:title></bib:Journal>
`);
	}
	out.push(`  <z:Collection rdf:about="#c"><dc:title>All</dc:title>`);
	for (let i = 0; i < n; i += 7) out.push(`<dcterms:hasPart rdf:resource="#item_${i}"/>`);
	out.push("</z:Collection></rdf:RDF>");
	return out.join("");
}
