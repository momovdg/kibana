/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { Keyword, OptionalNode, OptionsArgument, SlotNode, SlotRole } from './types';

/*
 * What a spec cannot say, checked by the compiler: a line here stops compiling when the
 * vocabulary starts to accept it.
 */

type Accepts<Allowed, Given> = Given extends Allowed ? true : false;

describe('the vocabulary of a spec', () => {
  it('takes only the roles and the keywords it lists', () => {
    const unknownRole: Accepts<SlotRole, 'colum'> = false;
    const unknownKeyword: Accepts<Keyword, 'BYE'> = false;

    expect([unknownRole, unknownKeyword]).toEqual([false, false]);
  });

  it('takes the options of a role as that role needs them', () => {
    const noneForARoleWithout: Accepts<OptionsArgument<'column'>, []> = true;
    const noneForARoleThatNeedsThem: Accepts<OptionsArgument<'expression'>, []> = false;
    const anOptionOfTheWrongType: Accepts<
      OptionsArgument<'constant'>,
      [{ suggestedValues: number[] }]
    > = false;

    expect([noneForARoleWithout, noneForARoleThatNeedsThem, anOptionOfTheWrongType]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('starts a part that may be left out with a keyword', () => {
    const startsWithASlot: Accepts<OptionalNode['nodes'], [SlotNode]> = false;

    expect(startsWithASlot).toBe(false);
  });
});
