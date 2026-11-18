# Disk fallback Fluent bundle (fr)
hello = Bonjour, { $name } !
items =
    { $count ->
        [0] Aucun élément
        [one] Un élément
       *[other] { $count } éléments
    }
-brand = Zinc
about = À propos de { -brand }
button = Enregistrer
    .tooltip = Enregistrer le fichier
