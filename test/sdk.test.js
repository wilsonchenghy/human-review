import test from "node:test";
import assert from "node:assert/strict";

// jsdom (a dev dependency) needs Node 22+; the library itself supports Node 20.
let JSDOM = null;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  JSDOM = null;
}
const skip = JSDOM ? false : "jsdom unavailable on this Node version";

const CHROME_ORIGIN = "http://localhost:4000";
let seq = 0;
/** The most recent boot, so its pending timers can be flushed before the next one takes the globals. */
let current = null;

/**
 * Boot the editor SDK against a jsdom document standing in for the review
 * iframe. The SDK talks to the chrome only through parent.postMessage, and
 * jsdom's parent is the window itself, so patching postMessage captures
 * every row it reports. Each boot re-imports the module with a cache-busting
 * query so module-level state starts fresh.
 */
async function bootSdk(body) {
  // Every instance posts through the global `parent`. An edit still sitting in
  // a previous instance's flush timer would land in this test's capture, so
  // drain it while the old window is still the global one.
  if (current) {
    current.fromChrome({ type: "eh:flush" });
    current = null;
  }
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>${body}</body></html>`, {
    url: "http://127.0.0.1:4000/artifact/t/k/index.html",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const posts = [];
  window.postMessage = (message) => posts.push(JSON.parse(JSON.stringify(message)));
  // jsdom has no layout: give Range the geometry the link popup asks for.
  if (!window.Range.prototype.getBoundingClientRect) {
    const zero = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
    window.Range.prototype.getBoundingClientRect = zero;
    window.Range.prototype.getClientRects = () => [];
  }
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = (value) => String(value).replace(/[^\w-]/g, (c) => `\\${c}`);
  for (const name of Object.getOwnPropertyNames(window)) {
    if (name === "undefined" || name in globalThis) continue;
    try {
      globalThis[name] = window[name];
    } catch {}
  }
  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    parent: window,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    CSS: window.CSS,
    NodeFilter: window.NodeFilter,
    MutationObserver: window.MutationObserver,
    DOMParser: window.DOMParser,
  });
  seq += 1;
  await import(`../src/sdk.js?boot=${seq}`);
  const fromChrome = (data) => window.dispatchEvent(new window.MessageEvent("message", { data, origin: CHROME_ORIGIN, source: window }));
  const shadow = window.document.querySelector("[data-eh-ui]").shadowRoot;
  current = { fromChrome };
  return { window, document: window.document, posts, fromChrome, shadow };
}

const rows = (posts) => posts.filter((m) => m.type === "eh:edit").map(({ label, kind, before, after }) => ({ label, kind, before, after }));

test("deleting a block reports it, offers undo, and undo restores it", { skip }, async () => {
  const { document, posts, fromChrome, shadow } = await bootSdk("<h1>Plan</h1><p>Keep me.</p><p>Delete me.</p><p>Closing.</p>");
  const target = document.querySelectorAll("p")[1];
  target.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  shadow.getElementById("chipDelete").click();

  assert.equal(document.querySelectorAll("p").length, 2);
  assert.deepEqual(rows(posts), [{ label: "Plan · p 2", kind: "deleted", before: "Delete me.", after: "" }]);
  assert.ok(posts.some((m) => m.type === "eh:undoable" && m.kind === "deleted" && m.label === "Plan · p 2"));
  assert.ok(posts.some((m) => m.type === "eh:html"), "the file is rewritten without the block");

  fromChrome({ type: "eh:undo", label: "Plan · p 2", kind: "deleted" });
  const texts = [...document.querySelectorAll("p")].map((p) => p.textContent);
  assert.deepEqual(texts, ["Keep me.", "Delete me.", "Closing."], "the block is back where it was");
  assert.ok(posts.some((m) => m.type === "eh:undone" && m.label === "Plan · p 2"), "the chrome is told so it can drop the row");

  // Nothing left to restore under that label: the chrome hears that too.
  fromChrome({ type: "eh:undo", label: "Plan · p 2", kind: "deleted" });
  assert.ok(posts.some((m) => m.type === "eh:undoFailed"));
});

test("older deletes stay restorable, and ⌘Z undoes the latest one unless typing came after", { skip }, async () => {
  const { window, document, posts, fromChrome, shadow } = await bootSdk("<h1>Plan</h1><p>One.</p><p>Two.</p><p>Three.</p>");
  const [one, two, three] = document.querySelectorAll("p");
  for (const p of [one, two]) {
    p.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
    shadow.getElementById("chipDelete").click();
  }
  assert.deepEqual([...document.querySelectorAll("p")].map((p) => p.textContent), ["Three."]);

  // The first deletion, not the most recent, restores from the edit list.
  fromChrome({ type: "eh:undo", label: "Plan · p 1", kind: "deleted" });
  assert.deepEqual([...document.querySelectorAll("p")].map((p) => p.textContent), ["One.", "Three."]);

  // ⌘Z right after the remaining deletion brings the second one back.
  document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
  assert.deepEqual([...document.querySelectorAll("p")].map((p) => p.textContent), ["One.", "Two.", "Three."]);

  // After typing, ⌘Z is the browser's own undo again: nothing of ours moves.
  three.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  shadow.getElementById("chipDelete").click();
  one.dispatchEvent(new window.Event("input", { bubbles: true }));
  const zed = new window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
  document.body.dispatchEvent(zed);
  assert.equal(zed.defaultPrevented, false);
  assert.deepEqual([...document.querySelectorAll("p")].map((p) => p.textContent), ["One.", "Two."]);
  assert.equal(posts.filter((m) => m.type === "eh:undone").length, 2);
});

test("typing over a selection that spans blocks reports every block it touched", { skip }, async () => {
  const { window, document, posts, fromChrome } = await bootSdk("<h2>Goals</h2><p>First goal paragraph.</p><p>Second goal paragraph.</p>");
  const [first, second] = document.querySelectorAll("p");
  const range = document.createRange();
  range.setStart(first.firstChild, 6);
  range.setEnd(second.firstChild, 7);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  first.dispatchEvent(new window.Event("beforeinput", { bubbles: true }));
  // What the browser does for a keystroke over that selection: the first
  // block absorbs the remainder of the second, which disappears.
  first.textContent = "First Xgoal paragraph.";
  second.remove();
  first.dispatchEvent(new window.Event("input", { bubbles: true }));
  fromChrome({ type: "eh:flush" });

  assert.deepEqual(rows(posts), [
    { label: "Goals · p 1", kind: "edited", before: "First goal paragraph.", after: "First Xgoal paragraph." },
    { label: "Goals · p 2", kind: "deleted", before: "Second goal paragraph.", after: "" },
  ]);
});

test("a keyboard selection opens the compose card when the key is released", { skip }, async () => {
  const { window, document, posts } = await bootSdk("<h1>Plan</h1><p>Select these words with the keyboard.</p>");
  const p = document.querySelector("p");
  const range = document.createRange();
  range.setStart(p.firstChild, 7);
  range.setEnd(p.firstChild, 12);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  p.dispatchEvent(new window.KeyboardEvent("keyup", { key: "ArrowRight", shiftKey: true, bubbles: true }));
  p.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Shift", bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const compose = posts.filter((m) => m.type === "eh:compose");
  assert.equal(compose.length, 1, "one card for the settled selection, not one per keystroke");
  assert.equal(compose[0].kind, "selection");
  assert.equal(compose[0].quote, "these");
});

test("labels number siblings by their order at load, so a deletion does not renumber the rest", { skip }, async () => {
  const { document, posts, shadow } = await bootSdk("<h2>Goals</h2><p>One.</p><p>Two.</p><p>Three.</p>");
  const paragraphs = document.querySelectorAll("p");
  paragraphs[1].dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  shadow.getElementById("chipDelete").click();
  paragraphs[2].dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  shadow.getElementById("chipDelete").click();
  assert.deepEqual(
    rows(posts).map((r) => r.label),
    ["Goals · p 2", "Goals · p 3"],
    "the third paragraph keeps its number after the second is gone"
  );
});

/**
 * jsdom has no execCommand. This stand-in does what Chrome does for the two
 * commands the list paths use: delete the selection, and turn the block the
 * caret is in into a list item. It fires the input event Chrome fires too.
 */
function installExecCommand(window) {
  window.document.execCommand = (command) => {
    const document = window.document;
    const sel = window.getSelection();
    if (command === "delete") {
      if (sel.rangeCount) sel.getRangeAt(0).deleteContents();
      document.body.dispatchEvent(new window.Event("input", { bubbles: true }));
      return true;
    }
    if (command === "insertUnorderedList" || command === "insertOrderedList") {
      let node = sel.anchorNode;
      let block = node && (node.nodeType === 1 ? node : node.parentElement);
      while (block && block !== document.body && !/^(p|div|h[1-6])$/i.test(block.tagName)) block = block.parentElement;
      if (!block || block === document.body) return false;
      const list = document.createElement(command === "insertOrderedList" ? "ol" : "ul");
      const item = document.createElement("li");
      while (block.firstChild) item.appendChild(block.firstChild);
      list.appendChild(item);
      block.replaceWith(list);
      const range = document.createRange();
      range.selectNodeContents(item);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      item.dispatchEvent(new window.Event("input", { bubbles: true }));
      return true;
    }
    return false;
  };
}

test("typing a list marker turns the paragraph into a list under the paragraph's own label", { skip }, async () => {
  const { window, document, posts, fromChrome } = await bootSdk("<h2>Goals</h2><p>-Ship it.</p>");
  installExecCommand(window);
  const p = document.querySelector("p");
  const range = document.createRange();
  range.setStart(p.firstChild, 1);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const space = new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  p.dispatchEvent(space);
  assert.equal(space.defaultPrevented, true, "the marker keystroke is consumed");
  assert.equal(document.querySelector("ul li").textContent, "Ship it.");
  fromChrome({ type: "eh:flush" });
  assert.deepEqual(rows(posts), [{ label: "Goals · p", kind: "edited", before: "-Ship it.", after: "Ship it." }]);
  const row = posts.find((m) => m.type === "eh:edit");
  assert.match(row.after_html, /^<li>Ship it\.<\/li>$/);
});

test("⌘K on an existing link retargets it, and Remove unwraps it, each as one edit row", { skip }, async () => {
  const { window, document, posts, fromChrome, shadow } = await bootSdk('<h2>Links</h2><p>Read <a href="https://old.example">the spec</a> first.</p>');
  const anchor = document.querySelector("a");
  const caret = document.createRange();
  caret.setStart(anchor.firstChild, 2);
  caret.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(caret);

  const k = new window.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true });
  anchor.dispatchEvent(k);
  assert.equal(k.defaultPrevented, true);
  const input = shadow.getElementById("linkInput");
  assert.equal(input.value, "https://old.example", "the popup opens on the link's current target");
  input.value = "new.example/spec";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  assert.equal(anchor.getAttribute("href"), "https://new.example/spec", "a bare domain gets a scheme");
  fromChrome({ type: "eh:flush" });
  assert.deepEqual(rows(posts), [{ label: "Links · p", kind: "edited", before: "Read the spec first.", after: "Read the spec first." }]);
  assert.match(posts.find((m) => m.type === "eh:edit").after_html, /href="https:\/\/new\.example\/spec"/);

  posts.length = 0;
  sel.removeAllRanges();
  sel.addRange(caret);
  anchor.dispatchEvent(new window.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
  shadow.getElementById("linkRemove").click();
  assert.equal(document.querySelector("a"), null, "the link is gone, its text stays");
  assert.equal(document.querySelector("p").textContent, "Read the spec first.");
  fromChrome({ type: "eh:flush" });
  const removed = posts.find((m) => m.type === "eh:edit");
  assert.equal(removed.after_html, "<p>Read the spec first.</p>");
});

test("a plain click reaches tabs and toggles, but not bare buttons or links", { skip }, async () => {
  const { window, document } = await bootSdk(
    `<button type="button" id="tab" aria-expanded="false"><span>Find work to automate</span></button>
     <div role="tab" id="roletab">Advisor</div>
     <button type="button" id="bare">Delete item</button>
     <a href="/next"><button type="button" id="linked" aria-expanded="false">Next page</button></a>`
  );
  const reached = new Set();
  for (const id of ["tab", "roletab", "bare", "linked"]) document.getElementById(id).addEventListener("click", () => reached.add(id));
  const click = (el, init = {}) => {
    const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(event);
    return event;
  };

  assert.equal(click(document.querySelector("#tab span")).defaultPrevented, false, "clicking the tab's title switches the tab");
  click(document.getElementById("roletab"));
  assert.equal(click(document.getElementById("bare")).defaultPrevented, true);
  assert.equal(click(document.getElementById("linked")).defaultPrevented, true, "a toggle inside a link still never navigates");
  assert.deepEqual([...reached].sort(), ["roletab", "tab"]);

  click(document.getElementById("bare"), { metaKey: true });
  assert.ok(reached.has("bare"), "⌘-click still runs a bare button");
});

test("a pasted image lands at the caret once the chrome confirms where it was saved", { skip }, async () => {
  const { window, document, posts, fromChrome } = await bootSdk("<h2>Design</h2><p>Before the image.</p>");
  const p = document.querySelector("p");
  const caret = document.createRange();
  caret.setStart(p.firstChild, p.firstChild.length);
  caret.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(caret);

  const paste = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { items: [{ kind: "file", type: "image/png", getAsFile: () => ({ type: "image/png", arrayBuffer: async () => new ArrayBuffer(4) }) }] },
  });
  p.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, true, "the SDK owns image pastes");
  for (let i = 0; i < 50 && !posts.some((m) => m.type === "eh:asset"); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const asset = posts.find((m) => m.type === "eh:asset");
  assert.ok(asset, "the bytes go to the chrome to be saved");
  assert.equal(asset.assetType, "image/png");

  fromChrome({ type: "eh:assetSaved", id: asset.id, src: "assets/design-paste-1.png" });
  const img = document.querySelector("p img");
  assert.ok(img, "the image is inserted at the caret");
  assert.equal(img.getAttribute("src"), "assets/design-paste-1.png");
  const row = posts.find((m) => m.type === "eh:edit");
  assert.equal(row.label, "Design · p");
  assert.equal(row.before, "Before the image.");
  assert.match(row.after_html, /<img src="assets\/design-paste-1\.png"/);
});

test("an image file dragged in from the desktop is uploaded like a paste", { skip }, async () => {
  const { window, document, posts, fromChrome } = await bootSdk("<h2>Design</h2><p>Before the image.</p>");
  const p = document.querySelector("p");
  const drop = (files) => {
    const event = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } });
    p.dispatchEvent(event);
    return event;
  };

  assert.equal(drop([{ type: "application/pdf" }]).defaultPrevented, true, "a dropped file never navigates the page");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!posts.some((m) => m.type === "eh:asset"), "non-image files are ignored");

  assert.equal(drop([{ type: "image/jpeg", arrayBuffer: async () => new ArrayBuffer(4) }]).defaultPrevented, true);
  for (let i = 0; i < 50 && !posts.some((m) => m.type === "eh:asset"); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const asset = posts.find((m) => m.type === "eh:asset");
  assert.ok(asset, "the bytes go to the chrome to be saved");
  assert.equal(asset.assetType, "image/jpeg");

  fromChrome({ type: "eh:assetSaved", id: asset.id, src: "assets/design-paste-1.jpg" });
  assert.ok(document.querySelector('img[src="assets/design-paste-1.jpg"]'), "the image is inserted into the page");
  assert.ok(posts.some((m) => m.type === "eh:edit"), "and reported as an edit");
});

test("shift-click adds a second image to one element comment", { skip }, async () => {
  const { window, document, posts } = await bootSdk('<h2>Arm</h2><div><img alt="a" src="a.png"><img alt="b" src="b.png"></div>');
  const [a, b] = document.querySelectorAll("img");
  const click = (el, shiftKey) => el.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, shiftKey }));
  click(a, false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  click(b, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const last = posts.filter((m) => m.type === "eh:compose").at(-1);
  assert.match(last.quote, / \+ /);
  assert.equal(last.anchor.selectors.length, 2);
  assert.ok(b.hasAttribute("data-eh-pick"));
});

test("Send reports the page as it looks now: a restored block is not deleted, a new paragraph keeps its own row", { skip }, async () => {
  const { window, document, posts, fromChrome } = await bootSdk("<h2>TVC</h2><p>Intro.</p><video src=\"v.mp4\"></video><p>Fins.</p><p>Thrust.</p>");
  const [intro, fins, thrust] = document.querySelectorAll("p");
  const video = document.querySelector("video");
  const sel = window.getSelection();
  const select = (a, ao, b, bo) => {
    const range = document.createRange();
    range.setStart(a, ao);
    range.setEnd(b, bo);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  // A selection from the intro into "Fins." swallows the video; then a native ⌘Z puts it all back.
  select(intro.firstChild, 3, fins.firstChild, 2);
  intro.dispatchEvent(new window.Event("beforeinput", { bubbles: true }));
  intro.textContent = "Intns.";
  video.remove();
  fins.remove();
  intro.dispatchEvent(new window.Event("input", { bubbles: true }));
  intro.textContent = "Intro.";
  intro.after(video);
  video.after(fins);

  // Delete "Fins." and add a paragraph after "Thrust." (Enter makes a fresh <p>).
  select(fins.firstChild, 0, fins.firstChild, 5);
  fins.dispatchEvent(new window.Event("beforeinput", { bubbles: true }));
  fins.remove();
  fins.dispatchEvent(new window.Event("input", { bubbles: true }));
  const added = document.createElement("p");
  added.textContent = "B";
  thrust.after(added);
  select(added.firstChild, 1, added.firstChild, 1);
  added.dispatchEvent(new window.Event("beforeinput", { bubbles: true }));
  added.textContent = "Brand new.";
  added.dispatchEvent(new window.Event("input", { bubbles: true }));

  fromChrome({ type: "eh:flush", reconcile: true });
  const live = new Map();
  for (const m of posts) {
    const key = `${m.label}|${m.kind}`;
    if (m.type === "eh:edit") live.set(key, m.after);
    if (m.type === "eh:dropEdit") live.delete(key);
  }
  const labels = [...live.keys()];
  assert.ok(!labels.some((k) => k.endsWith("|deleted") && live.get(k) === "" && /video|· p 1\|/.test(k)), `nothing restored is reported deleted: ${labels}`);
  assert.ok(!labels.includes("TVC · p 1|edited"), "the intro is back to its original wording");
  assert.ok(labels.includes("TVC · p 2|deleted"), "the fins paragraph is deleted");
  assert.equal(live.get("TVC · new p|edited"), "Brand new.", "the new paragraph has its own row");
  const placed = posts.filter((m) => m.type === "eh:edit" && m.label === "TVC · new p").at(-1);
  assert.equal(placed.placed_after, "Thrust.", "and says where it sits");
  assert.equal(placed.before, "", "its first keystroke is not its original text");
});

test("deleting an image reports its markup, so the agent knows which image went", { skip }, async () => {
  const { window, document, posts, shadow } = await bootSdk('<h2>TVC</h2><p><img src="new.svg"></p><p><img src="old.png"></p>');
  const old = document.querySelectorAll("img")[1];
  old.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  shadow.getElementById("chipDelete").click();
  const row = posts.find((m) => m.type === "eh:edit" && m.kind === "deleted");
  assert.match(row.before_html, /old\.png/);
});

test("a block the caret only passed through is not reported at Send", { skip }, async () => {
  const { window, document, posts, fromChrome } = await bootSdk("<h2>PID</h2><ul><li><p>Text.</p><p>Equation.</p></li></ul>");
  const [text, eq] = document.querySelectorAll("p");
  const range = document.createRange();
  range.setStart(text.firstChild, 4);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  text.dispatchEvent(new window.Event("beforeinput", { bubbles: true }));
  text.textContent = "Text!";
  // The input lands while the selection already sits in the equation.
  range.setStart(eq.firstChild, 0);
  eq.dispatchEvent(new window.Event("input", { bubbles: true }));
  text.dispatchEvent(new window.Event("input", { bubbles: true }));
  fromChrome({ type: "eh:flush", reconcile: true });
  const live = new Map();
  for (const m of posts) {
    if (m.type === "eh:edit") live.set(m.label, m.after);
    if (m.type === "eh:dropEdit") live.delete(m.label);
  }
  assert.deepEqual([...live.entries()], [["PID · p 1", "Text!"]]);
});

test("the selected block's outline follows the page when it scrolls", { skip }, async () => {
  const { window, document, shadow } = await bootSdk("<h2>Arm</h2><p>Pick me.</p>");
  const p = document.querySelector("p");
  let top = 100;
  p.getBoundingClientRect = () => ({ left: 10, top, right: 210, bottom: top + 20, width: 200, height: 20 });
  p.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const box = shadow.getElementById("activeBox");
  assert.equal(box.style.top, "98px");
  top = 40;
  window.dispatchEvent(new window.Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(box.style.top, "38px");
});

test("shift-click inside the same block extends the text selection instead of picking blocks", { skip }, async () => {
  const { window, document, posts } = await bootSdk("<h2>Arm</h2><p>Select a chunk of these words.</p>");
  const p = document.querySelector("p");
  p.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const range = document.createRange();
  range.setStart(p.firstChild, 7);
  range.setEnd(p.firstChild, 14);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  p.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, shiftKey: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const last = posts.filter((m) => m.type === "eh:compose").at(-1);
  assert.equal(last.kind, "selection");
  assert.equal(last.quote, "a chunk");
});
