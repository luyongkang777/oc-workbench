import fs from "node:fs";

const spec = JSON.parse(fs.readFileSync("figma-workbench-spec.json", "utf8"));
const params = {
  parent: "92:2",
  confirm: true,
  spec: spec,
};

fs.writeFileSync("figma-params.json", JSON.stringify(params, null, 2), "utf8");
console.log("figma-params.json written");
