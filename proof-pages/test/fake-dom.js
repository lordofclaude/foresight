export class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase(); this.children = []; this.attributes = {};
    this.className = ""; this._textContent = ""; this.listeners = {}; this.hidden = false;
  }
  set textContent(value) { this._textContent = String(value); this.children = []; }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(""); }
  append(...nodes) { for (const node of nodes) if (node) this.children.push(node); }
  replaceChildren(...nodes) { this.children = []; this._textContent = ""; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  queryAll(tagName) {
    const wanted = tagName.toUpperCase(), output = this.tagName === wanted ? [this] : [];
    for (const child of this.children) output.push(...child.queryAll(wanted));
    return output;
  }
}

export class FakeDocument {
  constructor(ids = []) {
    this.nodes = new Map(ids.map(id => { const node = new FakeElement(id.includes("status") ? "p" : "main"); node.id = id; return [id, node]; }));
    this.title = ""; this.createdTags = [];
  }
  createElement(tagName) { this.createdTags.push(tagName.toLowerCase()); return new FakeElement(tagName); }
  getElementById(id) { return this.nodes.get(id) || null; }
}
