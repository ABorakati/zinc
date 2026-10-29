import type { Component, ComponentProps } from "solid-js"
import { splitProps } from "solid-js"

import { cn } from "~/lib/utils"

const base =
  "w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-[13px] shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"

const Input: Component<ComponentProps<"input">> = (props) => {
  const [local, others] = splitProps(props, ["class"])
  return <input class={cn(base, "h-7", local.class)} {...others} />
}

const Textarea: Component<ComponentProps<"textarea">> = (props) => {
  const [local, others] = splitProps(props, ["class"])
  return <textarea class={cn(base, "min-h-16 py-1 leading-snug", local.class)} {...others} />
}

export { Input, Textarea }
