import { MadeWithDyad } from "@/components/made-with-dyad";
import { AndroidAgent } from "@/components/AndroidAgent";

const Index = () => {
  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-gray-950 font-sans">
      <main className="flex-1 py-8 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto space-y-8">
          <div className="text-center space-y-2 mb-4">
            <h1 className="text-4xl md:text-5xl font-extrabold text-slate-900 dark:text-white tracking-tight">
              Survey<span className="text-orange-500">Pilot</span>
            </h1>
            <p className="text-lg text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
              Automated hybrid agent for Android survey applications.
            </p>
          </div>
          
          <AndroidAgent />
        </div>
      </main>
      <MadeWithDyad />
    </div>
  );
};

export default Index;