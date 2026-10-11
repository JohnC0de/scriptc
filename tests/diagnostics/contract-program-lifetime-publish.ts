// Publication marks a graph immortal by its reference count, which
// program-lifetime objects already carry, so their fields would stay
// thread-local: publishing them is refused.
import { publish } from "@scriptc/threads";
import type { ProgramLifetime } from "@scriptc/types";

class Tree implements ProgramLifetime {
  children: Tree[] = [];
  label = "root";
}

class Config {
  tree = new Tree();
  depth = 1;
}

const shared = publish(new Config());
console.log(shared.depth, shared.tree.label);
