declare module "markdown-it" {
  const MarkdownIt: any;
  export default MarkdownIt;
}

declare module "mathjax/tex-svg.js";
declare module "*?raw" {
  const content: string;
  export default content;
}
