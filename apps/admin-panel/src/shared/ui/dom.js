export function el(tagName, options = {}, children = []) {
  const element = document.createElement(tagName);

  if (options.className) {
    element.className = options.className;
  }

  if (options.text !== undefined) {
    element.textContent = options.text;
  }

  if (options.html !== undefined) {
    element.innerHTML = options.html;
  }

  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value !== undefined && value !== null) {
        element.setAttribute(name, String(value));
      }
    }
  }

  for (const child of children) {
    if (child) {
      element.append(child);
    }
  }

  return element;
}

export function clear(element) {
  while (element.firstChild) {
    element.firstChild.remove();
  }
}

export function badge(label, tone = "neutral") {
  return el("span", {
    className: `badge badge-${tone}`,
    text: label
  });
}
