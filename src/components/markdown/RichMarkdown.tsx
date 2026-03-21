import ReactMarkdown from "react-markdown";
import type { Components, UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";

type RichMarkdownProps = {
  content: string;
  components?: Components;
  className?: string;
  urlTransform?: UrlTransform;
};

export function RichMarkdown({ content, components, className, urlTransform }: RichMarkdownProps) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeRaw, rehypeKatex]} components={components} urlTransform={urlTransform}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
