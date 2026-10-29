import type { JSX, ValidComponent } from "solid-js"
import { splitProps } from "solid-js"

import * as CheckboxPrimitive from "@kobalte/core/checkbox"
import type { PolymorphicProps } from "@kobalte/core/polymorphic"
import { Check } from "lucide-solid"

import { cn } from "~/lib/utils"

type CheckboxProps<T extends ValidComponent = "div"> = CheckboxPrimitive.CheckboxRootProps<T> & {
  class?: string | undefined
  /** text/node shown after the box */
  label?: JSX.Element
  "aria-label"?: string
}

const Checkbox = <T extends ValidComponent = "div">(props: PolymorphicProps<T, CheckboxProps<T>>) => {
  const [local, others] = splitProps(props as CheckboxProps, ["class", "label", "aria-label"])
  return (
    <CheckboxPrimitive.Root class={cn("inline-flex items-center gap-2", local.class)} {...others}>
      <CheckboxPrimitive.Input class="peer" aria-label={local["aria-label"]} />
      <CheckboxPrimitive.Control class="flex size-4 flex-none items-center justify-center rounded-[4px] border border-input bg-background text-primary-foreground transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring data-[checked]:border-primary data-[checked]:bg-primary">
        <CheckboxPrimitive.Indicator>
          <Check class="size-3" strokeWidth={3} />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Control>
      {local.label}
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
