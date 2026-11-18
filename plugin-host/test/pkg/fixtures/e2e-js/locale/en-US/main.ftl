# strings of the e2e plugin
hello = Hello, { $name }!
items =
    { $count ->
        [one] One item
       *[other] { $count } items
    }
multi =
    first line
    second line
-brand = Zinc
about = About { -brand }
button = Save
    .tooltip = Save the file
only-en = Only in English
