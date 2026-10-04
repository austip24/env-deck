import { Toaster } from "@/components/ui/sonner";

function App() {
  return (
    <div className="flex h-full">
      <aside className="w-72 shrink-0 border-r bg-sidebar text-sidebar-foreground" />
      <main className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        EnvDeck
      </main>
      <Toaster />
    </div>
  );
}

export default App;
