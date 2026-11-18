# Disk fallback Fluent bundle (en-US)
hello = Hello, { $name }!
items =
    { $count ->
        [0] No items
        [one] One item
       *[other] { $count } items
    }
-brand = Zinc
about = About { -brand }
button = Save
    .tooltip = Save the file
disk-only = From disk en-US
