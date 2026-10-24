import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { go } from "./router";

export function Link({ href, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go(href);
  };
  return <a href={href} onClick={onClick} {...rest} />;
}
