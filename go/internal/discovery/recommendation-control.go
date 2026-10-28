package discovery

import "strings"

const recommendationAlgorithm = "galaxy-opportunity-v1"

var recommendationConstraints = Object{"personalNeeds": true, "supply": true, "negativeFeedback": true}

func defaultPolicy() Object {
	return Object{"version": int64(0), "enabled": false, "directions": []Object{}, "controls": Object{"avoidRepetition": false, "avoidConcentration": false}, "fixedConstraints": recommendationConstraints, "updatedAt": nil, "algorithm": recommendationAlgorithm}
}
func policyView(row Object) Object {
	if row == nil {
		return defaultPolicy()
	}
	return Object{"version": row["revision"], "enabled": row["enabled"], "directions": row["directions"], "controls": row["controls"], "fixedConstraints": recommendationConstraints, "updatedAt": stamp(row["updated_at"]), "algorithm": recommendationAlgorithm}
}
func themeView(row Object) Object {
	return Object{"key": "theme:" + str(row, "id"), "id": row["id"], "label": row["label"], "kind": "theme", "version": row["revision"], "enabled": row["enabled"], "mapping": row["mapping"], "source": "operator-mapping"}
}
func containsString(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func themeMatches(theme Object, document *Document) bool {
	if theme["enabled"] != true {
		return false
	}
	mapping := object(theme["mapping"])
	categories, _ := stringArray(mapping["categories"])
	if containsString(categories, document.Topic) {
		return true
	}
	tags, _ := stringArray(mapping["tagIds"])
	for _, tag := range tags {
		if containsString(document.TagIDs, tag) {
			return true
		}
	}
	return false
}
func themeKeys(themes []Object, document *Document) []string {
	out := []string{}
	for _, theme := range themes {
		if themeMatches(theme, document) {
			out = append(out, str(theme, "key"))
		}
	}
	return out
}

type RecommendationPlan struct {
	Policy            Object
	Themes            []Object
	PreviouslyExposed map[string]bool
}
type recommendationCandidate struct {
	Document  *Document
	Candidate Object
	Mode      string
	Themes    []string
	Direction int
}

func objects(value any) []Object {
	switch rows := value.(type) {
	case []Object:
		return rows
	case []any:
		out := []Object{}
		for _, row := range rows {
			if o := object(row); o != nil {
				out = append(out, o)
			}
		}
		return out
	}
	return nil
}
func applyControl(candidates []recommendationCandidate, plan RecommendationPlan) []recommendationCandidate {
	if plan.Policy["enabled"] != true {
		return candidates
	}
	directions := map[string]string{}
	for _, row := range objects(plan.Policy["directions"]) {
		directions[str(row, "key")] = str(row, "direction")
	}
	rows := append([]recommendationCandidate{}, candidates...)
	for i := range rows {
		rows[i].Themes = themeKeys(plan.Themes, rows[i].Document)
		increase, decrease := false, false
		for _, key := range rows[i].Themes {
			increase = increase || directions[key] == "increase"
			decrease = decrease || directions[key] == "decrease"
		}
		if increase != decrease {
			if increase {
				rows[i].Direction = 1
			} else {
				rows[i].Direction = -1
			}
		}
	}
	for i := 0; i+1 < len(rows); i++ {
		if rows[i+1].Direction > rows[i].Direction {
			rows[i], rows[i+1] = rows[i+1], rows[i]
			i++
		}
	}
	selected := []recommendationCandidate{}
	controls := object(plan.Policy["controls"])
	for len(rows) > 0 {
		pool := []int{}
		if controls["avoidRepetition"] == true {
			for i, row := range rows {
				if !plan.PreviouslyExposed[row.Document.ID] {
					pool = append(pool, i)
				}
			}
		}
		if len(pool) == 0 {
			for i := range rows {
				pool = append(pool, i)
			}
		}
		choice := pool[0]
		if controls["avoidConcentration"] == true {
			for _, i := range pool {
				collides := false
				if len(selected) > 0 {
					previous := selected[len(selected)-1]
					current := rows[i]
					if previous.Document.AuthorAccountID != nil && current.Document.AuthorAccountID != nil && *previous.Document.AuthorAccountID == *current.Document.AuthorAccountID {
						collides = true
					}
					previousThemes := []string{}
					for _, key := range previous.Themes {
						if strings.HasPrefix(key, "theme:") {
							previousThemes = append(previousThemes, key)
						}
					}
					if len(previousThemes) > 0 {
						for _, key := range current.Themes {
							collides = collides || containsString(previousThemes, key)
						}
					} else {
						collides = collides || previous.Document.Topic == current.Document.Topic
					}
				}
				if !collides {
					choice = i
					break
				}
			}
		}
		selected = append(selected, rows[choice])
		rows = append(rows[:choice], rows[choice+1:]...)
	}
	return selected
}
