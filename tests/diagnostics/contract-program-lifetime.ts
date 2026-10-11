// ProgramLifetime is checked on the root class of a hierarchy, which every
// subclass then inherits. Built-in bases keep runtime state that is
// released with the object.
import type { ProgramLifetime } from "@scriptc/types";

class Base {
  id = 0;
}

class Derived extends Base implements ProgramLifetime {
  name = "d";
}

class Failure extends Error implements ProgramLifetime {}

console.log(new Derived().name, new Base().id, new Failure("x").message);
