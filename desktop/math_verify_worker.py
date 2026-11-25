"""Sandboxed AST-validated Python Math & Scientific Verification Worker for AutoTask AI.

Reads JSON from stdin:
  { "items": [ { "id": "q1", "code": "comb(10, 3) / comb(15, 3)" } ] }
Emits JSON to stdout:
  { "ok": true, "results": [ { "id": "q1", "ok": true, "display": "24/91 (~0.263736)", "numeric": 0.2637362637, "fraction": "24/91" } ] }

Security: Strictly rejects non-math imports, dunder/underscore attributes, eval/exec/open/os/sys/network access,
and unbounded computations before executing any expression.
"""
from __future__ import annotations

import ast
import cmath
import decimal
import functools
import io
import itertools
import json
import math
import re
import statistics
import sys
from fractions import Fraction
from pathlib import Path

# Prevent local desktop scripts (e.g. desktop/secrets.py) from shadowing stdlib modules imported by SciPy/NumPy
_SCRIPT_DIR = str(Path(__file__).resolve().parent)
sys.path = [p for p in sys.path if not p or str(Path(p).resolve()) != _SCRIPT_DIR]

SAFE_MODULES = {
    'math',
    'cmath',
    'fractions',
    'decimal',
    'statistics',
    'itertools',
    'functools',
    'sympy',
    'numpy',
    'scipy',
}

BLOCKED_NAMES = {
    'exec',
    'eval',
    'compile',
    'open',
    'input',
    'breakpoint',
    'globals',
    'locals',
    'vars',
    'dir',
    'getattr',
    'setattr',
    'delattr',
    'hasattr',
    'memoryview',
    'type',
    'object',
    'super',
    'exit',
    'quit',
    'help',
    'copyright',
    'credits',
    'license',
    'format',
    'format_map',
}

MAX_CODE_CHARS = 4000
MAX_AST_NODES = 600
MAX_RANGE_ITEMS = 200000
MAX_LITERAL_EXPONENT = 2000
MAX_LITERAL_SHIFT = 1000


def _safe_range(*args):
    r = range(*args)
    if len(r) > MAX_RANGE_ITEMS:
        raise ValueError(f'Range size {len(r)} exceeds sandbox cap ({MAX_RANGE_ITEMS})')
    return r


def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level != 0:
        raise ImportError('Relative imports are forbidden')
    top = str(name or '').split('.')[0]
    if top not in SAFE_MODULES or any(seg.startswith('_') for seg in str(name).split('.')):
        raise ImportError(f'Blocked module in math sandbox: {name}')
    return __import__(name, globals, locals, fromlist, 0)


class _SafeMathValidator(ast.NodeVisitor):
    def __init__(self) -> None:
        self.node_count = 0

    def generic_visit(self, node: ast.AST) -> None:
        self.node_count += 1
        if self.node_count > MAX_AST_NODES:
            raise ValueError(f'Expression exceeds maximum AST complexity ({MAX_AST_NODES} nodes)')
        super().generic_visit(node)

    def _check_ident(self, name: str | None) -> None:
        if not name:
            return
        if name.startswith('_') or name in BLOCKED_NAMES:
            raise ValueError(f'Blocked identifier in math sandbox: {name}')

    def visit_Import(self, node: ast.Import) -> None:
        self.node_count += 1
        for alias in node.names:
            top = alias.name.split('.')[0]
            if top not in SAFE_MODULES or any(s.startswith('_') for s in alias.name.split('.')):
                raise ValueError(f'Blocked import: {alias.name}')
            if alias.asname:
                self._check_ident(alias.asname)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        self.node_count += 1
        if (node.level or 0) != 0 or not node.module:
            raise ValueError('Relative or empty import is forbidden')
        top = node.module.split('.')[0]
        if top not in SAFE_MODULES or any(s.startswith('_') for s in node.module.split('.')):
            raise ValueError(f'Blocked import from: {node.module}')
        for alias in node.names:
            self._check_ident(alias.name)
            if alias.asname:
                self._check_ident(alias.asname)

    def visit_Name(self, node: ast.Name) -> None:
        self._check_ident(node.id)
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        self._check_ident(node.attr)
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._check_ident(node.name)
        if node.decorator_list:
            raise ValueError('Decorators are not permitted in math sandbox')
        for a in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]:
            self._check_ident(a.arg)
        if node.args.vararg:
            self._check_ident(node.args.vararg.arg)
        if node.args.kwarg:
            self._check_ident(node.args.kwarg.arg)
        self.generic_visit(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        raise ValueError('Class definitions are forbidden in math sandbox')

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        raise ValueError('Async functions are forbidden in math sandbox')

    def visit_Await(self, node: ast.Await) -> None:
        raise ValueError('Await is forbidden in math sandbox')

    def visit_Yield(self, node: ast.Yield) -> None:
        raise ValueError('Yield is forbidden in math sandbox')

    def visit_YieldFrom(self, node: ast.YieldFrom) -> None:
        raise ValueError('YieldFrom is forbidden in math sandbox')

    def visit_Global(self, node: ast.Global) -> None:
        raise ValueError('Global statement is forbidden in math sandbox')

    def visit_Nonlocal(self, node: ast.Nonlocal) -> None:
        raise ValueError('Nonlocal statement is forbidden in math sandbox')

    def visit_Delete(self, node: ast.Delete) -> None:
        raise ValueError('Delete statement is forbidden in math sandbox')

    def visit_Try(self, node: ast.Try) -> None:
        raise ValueError('Try/except is forbidden in math sandbox')

    def visit_With(self, node: ast.With) -> None:
        raise ValueError('With/context managers are forbidden in math sandbox')

    def visit_While(self, node: ast.While) -> None:
        raise ValueError('While loops are forbidden in math sandbox (use bounded for/range)')

    def visit_BinOp(self, node: ast.BinOp) -> None:
        if isinstance(node.op, ast.Pow) and isinstance(node.right, ast.Constant):
            if isinstance(node.right.value, (int, float)) and abs(node.right.value) > MAX_LITERAL_EXPONENT:
                raise ValueError('Exponent exceeds math sandbox safety cap')
        if isinstance(node.op, ast.LShift) and isinstance(node.right, ast.Constant):
            if isinstance(node.right.value, int) and abs(node.right.value) > MAX_LITERAL_SHIFT:
                raise ValueError('Bit-shift exceeds math sandbox safety cap')
        self.generic_visit(node)


_SYMPY_HINT_RE = re.compile(
    r'\b(?:sympy|sp|symbols|Symbol|diff|integrate|limit|solve|linsolve|nonlinsolve|lambdify|hessian|simplify|expand|factor|Rational|Matrix|Eq|oo|Sum|Product|binomial|series|N)\b'
)
_NUMPY_HINT_RE = re.compile(r'\b(?:numpy|np)\b')


def _load_optional_scientific(ns: dict, code: str) -> None:
    if _SYMPY_HINT_RE.search(code):
        try:
            import sympy as sp  # type: ignore

            ns['sp'] = sp
            ns['sympy'] = sp
            for sym_name in (
                'symbols',
                'Symbol',
                'diff',
                'integrate',
                'limit',
                'solve',
                'simplify',
                'expand',
                'factor',
                'Rational',
                'Matrix',
                'Eq',
                'oo',
                'Sum',
                'Product',
                'binomial',
                'series',
                'N',
                'hessian',
                'linsolve',
                'nonlinsolve',
                'lambdify',
            ):
                if hasattr(sp, sym_name):
                    ns[sym_name] = getattr(sp, sym_name)
        except Exception:
            pass

    if _NUMPY_HINT_RE.search(code):
        try:
            import numpy as np  # type: ignore

            ns['np'] = np
            ns['numpy'] = np
        except Exception:
            pass


def _build_safe_globals(stdout_buf: io.StringIO, code: str) -> dict:
    def _captured_print(*args, **kwargs):
        sep = kwargs.get('sep', ' ')
        end = kwargs.get('end', '\n')
        stdout_buf.write(sep.join(str(a) for a in args) + end)

    safe_builtins = {
        '__import__': _safe_import,
        'abs': abs,
        'all': all,
        'any': any,
        'bool': bool,
        'complex': complex,
        'dict': dict,
        'divmod': divmod,
        'enumerate': enumerate,
        'filter': filter,
        'float': float,
        'int': int,
        'isinstance': isinstance,
        'len': len,
        'list': list,
        'map': map,
        'max': max,
        'min': min,
        'pow': pow,
        'print': _captured_print,
        'range': _safe_range,
        'reversed': reversed,
        'round': round,
        'set': set,
        'sorted': sorted,
        'str': str,
        'sum': sum,
        'tuple': tuple,
        'zip': zip,
        'True': True,
        'False': False,
        'None': None,
    }

    ns: dict = {
        '__builtins__': safe_builtins,
        'math': math,
        'cmath': cmath,
        'fractions': sys.modules['fractions'],
        'Fraction': Fraction,
        'decimal': decimal,
        'Decimal': decimal.Decimal,
        'statistics': statistics,
        'itertools': itertools,
        'functools': functools,
        'comb': math.comb,
        'perm': math.perm,
        'factorial': math.factorial,
        'gcd': math.gcd,
        'lcm': getattr(math, 'lcm', None),
        'sqrt': math.sqrt,
        'exp': math.exp,
        'log': math.log,
        'log10': math.log10,
        'log2': math.log2,
        'sin': math.sin,
        'cos': math.cos,
        'tan': math.tan,
        'asin': math.asin,
        'acos': math.acos,
        'atan': math.atan,
        'atan2': math.atan2,
        'ceil': math.ceil,
        'floor': math.floor,
        'pi': math.pi,
        'e': math.e,
        'inf': math.inf,
        'nan': math.nan,
        'mean': statistics.mean,
        'median': statistics.median,
        'stdev': statistics.stdev,
        'variance': statistics.variance,
        'pstdev': statistics.pstdev,
        'pvariance': statistics.pvariance,
    }
    _load_optional_scientific(ns, code)
    return ns


def _normalize_result(val, stdout_text: str) -> dict:
    numeric = None
    fraction_str = None
    display = None

    if val is None and stdout_text.strip():
        last_line = stdout_text.strip().splitlines()[-1].strip()
        display = last_line[:400]
        try:
            num = float(last_line)
            if math.isfinite(num):
                numeric = num
        except Exception:
            pass
    elif isinstance(val, bool):
        display = str(val)
    elif isinstance(val, int):
        display = str(val)
        if abs(val) < 1e15:
            numeric = float(val)
    elif isinstance(val, Fraction):
        fraction_str = f'{val.numerator}/{val.denominator}' if val.denominator != 1 else str(val.numerator)
        num = float(val)
        if math.isfinite(num):
            numeric = num
        display = f'{fraction_str} (~{num:.10g})' if val.denominator != 1 else fraction_str
    elif isinstance(val, decimal.Decimal):
        num = float(val)
        if math.isfinite(num):
            numeric = num
        display = str(val)
    elif isinstance(val, float):
        if math.isfinite(val):
            numeric = val
            display = f'{val:.10g}'
        else:
            display = str(val)
    elif hasattr(val, 'evalf'):
        # SymPy expression
        sym_str = str(val)
        try:
            fval = complex(val.evalf())
            if abs(fval.imag) < 1e-12 and math.isfinite(fval.real):
                numeric = float(fval.real)
                display = f'{sym_str} (~{numeric:.10g})' if str(numeric) != sym_str else sym_str
            else:
                display = sym_str
        except Exception:
            display = sym_str
    elif hasattr(val, 'tolist'):
        display = json.dumps(val.tolist(), ensure_ascii=False)[:400]
    else:
        display = str(val)[:400]

    out = {'ok': True}
    if display is not None:
        out['display'] = display
    if numeric is not None:
        out['numeric'] = numeric
    if fraction_str is not None:
        out['fraction'] = fraction_str
    if stdout_text.strip():
        out['stdout'] = stdout_text.strip()[:500]
    return out


def eval_single_item(item: dict) -> dict:
    item_id = str(item.get('id') or '')
    code = str(item.get('code') or '').strip()
    if not code:
        return {'id': item_id, 'ok': False, 'error': 'Empty code'}
    if len(code) > MAX_CODE_CHARS:
        return {'id': item_id, 'ok': False, 'error': 'Code exceeds length limit'}

    try:
        tree = ast.parse(code, mode='exec')
        _SafeMathValidator().visit(tree)

        stdout_buf = io.StringIO()
        ns = _build_safe_globals(stdout_buf, code)

        final_val = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            prefix = ast.Module(body=tree.body[:-1], type_ignores=[])
            expr = ast.Expression(body=tree.body[-1].value)
            ast.fix_missing_locations(prefix)
            ast.fix_missing_locations(expr)
            if prefix.body:
                exec(compile(prefix, '<math-sandbox>', 'exec'), ns, ns)
            final_val = eval(compile(expr, '<math-sandbox>', 'eval'), ns, ns)
        else:
            exec(compile(tree, '<math-sandbox>', 'exec'), ns, ns)
        if final_val is None:
            for key in ('result', 'ans', 'answer'):
                if key in ns:
                    final_val = ns[key]
                    break

        res = _normalize_result(final_val, stdout_buf.getvalue())
        res['id'] = item_id
        return res
    except Exception as err:
        return {'id': item_id, 'ok': False, 'error': str(err)[:240]}


def main() -> None:
    raw = sys.stdin.read(80000)
    req = json.loads(raw or '{}')
    items = req.get('items') if isinstance(req, dict) else []
    if not isinstance(items, list):
        raise ValueError('"items" must be a list')
    results = [eval_single_item(it) for it in items[:20] if isinstance(it, dict)]
    print(json.dumps({'ok': True, 'results': results}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as err:
        print(json.dumps({'ok': False, 'error': str(err)}, ensure_ascii=False))
        sys.exit(1)
